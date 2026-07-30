import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { withTimeout } from "./withTimeout";

/**
 * Claude-vision QC — the semantic half of shotQC.ts's measurements
 * (identity match, seated posture, plate structure, paste-look), plus
 * intake's own same-person consent guard (see schemas.ts's generatedScene
 * doc comment / the Kumar "Generated Shots v3" plan §3, §10). One shared
 * `askVision` call underneath every check here — same request/response
 * shape (N images + a question, one structured JSON answer back) — so the
 * Anthropic SDK boilerplate exists exactly once, matching this repo's
 * resolvers/anthropic.ts pattern (client.messages.parse + zodOutputFormat
 * for a guaranteed-schema response, no manual JSON parsing/retry).
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

let cachedClient: Anthropic | null = null;
const getClient = (): Anthropic => {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("faceCheck: ANTHROPIC_API_KEY is required (put it in .env)");
  }
  // Default SDK timeout is 10 MINUTES, and the SDK retries timeouts on its
  // own on top of that — a stuck connection during this format's own
  // multi-attempt Gemini ladder (each attempt runs 3-4 of these checks in
  // parallel) could silently cost 20-30+ minutes before finally
  // surfacing an error, which every caller here already wraps in its own
  // try/catch + fallback. 60s is comfortably above this call's own real
  // latency (a small structured-JSON vision call) and short enough that a
  // stuck connection fails fast into the fallback instead of stalling the
  // whole generate stage.
  cachedClient = new Anthropic({ timeout: 60_000 });
  return cachedClient;
};

const readImageBlock = (absPath: string): { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string } } => {
  const ext = path.extname(absPath).toLowerCase();
  const media_type = ext === ".png" ? ("image/png" as const) : ("image/jpeg" as const);
  return { type: "image", source: { type: "base64", media_type, data: fs.readFileSync(absPath).toString("base64") } };
};

/** One vision call, N reference images + a question, structured JSON
 *  back. `model` defaults to the cheapest vision-capable model — every
 *  check here is a small, cheap adjudication, not a creative task. */
const askVision = async <T>(imagePaths: string[], question: string, schema: z.ZodType<T>, model = DEFAULT_MODEL): Promise<T> => {
  const client = getClient();
  const content = [...imagePaths.map(readImageBlock), { type: "text" as const, text: question }];
  // withTimeout on top of the client's own `timeout: 60_000` (getClient) —
  // the SDK option is the real cancellation, this is a hard backstop for
  // when it doesn't fire (see withTimeout.ts's own doc comment — observed
  // directly this session).
  const response = await withTimeout(
    client.messages.parse({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(schema) },
    }),
    75_000,
    "faceCheck (Anthropic vision)",
  );
  if (!response.parsed_output) {
    throw new Error("faceCheck: response did not match schema");
  }
  return response.parsed_output;
};

// ---------------------------------------------------------------------------
// Hard gate: identity match
// ---------------------------------------------------------------------------

const FaceMatchSchema = z.object({
  samePerson: z.boolean(),
  confidence: z.number().min(0).max(1),
  whatDiffers: z.string(),
});
export type FaceMatchResult = z.infer<typeof FaceMatchSchema>;

export const FACE_MATCH_THRESHOLD = 0.75;

/** Compares a reference identity photo against a generated frame —
 *  generation/generatedShots.ts's retry ladder's hard gate. Threshold
 *  applied by the caller (FACE_MATCH_THRESHOLD), not baked in here, so a
 *  caller can log/inspect a below-threshold result before discarding it. */
export const checkFaceMatch = (referencePhotoPath: string, generatedImagePath: string): Promise<FaceMatchResult> =>
  askVision(
    [referencePhotoPath, generatedImagePath],
    "The FIRST image is a reference photo of a specific real person. The SECOND image is a generated " +
      "photograph that is supposed to depict the SAME person. Look carefully at facial structure, " +
      "eyes, nose, mouth, hairline, and overall build — ignore differences in pose, lighting, clothing, " +
      "or image style. Is the second image plausibly the same person as the first? Respond with your " +
      "honest confidence (0 = definitely a different person, 1 = certainly the same person) and, if " +
      "confidence is below 0.9, a brief note on what specifically differs.",
    FaceMatchSchema,
  );

/** Intake-time consent guard (plan §10): are all of a job's own uploaded
 *  identity photos the same person? Reuses the same underlying check —
 *  "same person across two photos" is symmetric regardless of which one
 *  is called "reference." */
export const checkSamePerson = (photoAPath: string, photoBPath: string): Promise<FaceMatchResult> =>
  askVision(
    [photoAPath, photoBPath],
    "Do these two photographs show the SAME real person? Ignore pose, lighting, clothing, and image " +
      "quality differences — judge only facial identity. Respond with your honest confidence (0 = " +
      "definitely different people, 1 = certainly the same person) and a brief note if below 0.9.",
    FaceMatchSchema,
  );

// ---------------------------------------------------------------------------
// Soft/semantic checks
// ---------------------------------------------------------------------------

const SofaPostureSchema = z.object({
  occludedBySofa: z.boolean(),
  cushionDeformation: z.boolean(),
  contactShadowAtCushion: z.boolean(),
  feetScalePlausible: z.boolean(),
  notes: z.string(),
});
export type SofaPostureResult = z.infer<typeof SofaPostureSchema>;

/** The semantic half of the sofa "genuinely seated" check (shotQC.ts's
 *  bboxBottomInSeatBand is the geometric half) — see the plan's own
 *  reasoning: a pasted cutout can sit at the right HEIGHT but can never
 *  be genuinely OCCLUDED by the furniture in front of/around it. */
export const checkSofaPosture = (generatedImagePath: string): Promise<SofaPostureResult> =>
  askVision(
    [generatedImagePath],
    "This photograph is supposed to show a person seated ON a chesterfield sofa, with their weight " +
      "genuinely resting on the seat cushion. Answer, as booleans: (1) occludedBySofa — is any part of " +
      "the person (thighs, hip, lower body) visibly occluded/blocked BY the sofa's own cushion or " +
      "armrest, the way a real seated body would be, rather than the person merely standing or floating " +
      "in front of the sofa? (2) cushionDeformation — does the seat cushion show any compression/" +
      "deformation under the person's weight? (3) contactShadowAtCushion — is there a visible, coherent " +
      "contact shadow where the body meets the cushion? (4) feetScalePlausible — are the person's feet/" +
      "legs sized plausibly relative to the sofa (not oversized or undersized)? Add a one-sentence note.",
    SofaPostureSchema,
  );

const PlateStructureSchema = z.object({
  sameSet: z.boolean(),
  addedElements: z.string(),
});
export type PlateStructureResult = z.infer<typeof PlateStructureSchema>;

/** Plate-fidelity structural check (plan §1's 4th mechanism) — catches
 *  what pixel-histogram comparisons can't: an added window, a piece of
 *  furniture, or rendered text/logo that wasn't in the original plate. */
export const checkPlateStructure = (generatedImagePath: string, platePath: string): Promise<PlateStructureResult> =>
  askVision(
    [platePath, generatedImagePath],
    "The FIRST image is an empty backdrop set. The SECOND image is supposed to show the SAME set with a " +
      "person added into it and NOTHING else changed. Is it recognizably the same set (same wall, same " +
      "furniture, same floor line)? Has anything been added that wasn't in the first image — furniture, " +
      "windows, text, a logo, watermark, or any other new element? List anything added, or say 'none'.",
    PlateStructureSchema,
  );

const PasteLookSchema = z.object({
  looksComposited: z.boolean(),
  reason: z.string(),
});
export type PasteLookResult = z.infer<typeof PasteLookSchema>;

/** General "does this look like a real photograph or a cutout pasted
 *  onto a background" check — the catch-all for artifacts the geometric
 *  edge/luma checks might miss (odd lighting mismatch, a halo, an
 *  inconsistent shadow direction). */
export const checkPasteLook = (generatedImagePath: string): Promise<PasteLookResult> =>
  askVision(
    [generatedImagePath],
    "Does this photograph look like a single, coherently-lit real photograph, or does it look like a " +
      "person cut out of one photo and pasted onto a different background (mismatched lighting, a visible " +
      "edge/halo around the person, an inconsistent or missing shadow, a flat/pasted appearance)? Answer " +
      "looksComposited (true if it looks pasted/composited) and a one-sentence reason.",
    PasteLookSchema,
  );

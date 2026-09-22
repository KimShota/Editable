import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authoringDir, repoRoot } from "../pipeline/paths";
import { listFormats, loadFormat } from "../pipeline/loader";
import { DraftSchema } from "./schemas";
import { Analysis, Draft } from "./types";

/**
 * Module A3 — Synthesize.
 * Reverse-engineers one analyzed reference clip into a draft Format: the
 * hard, judgment-heavy step the rest of authoring exists to feed. Needs
 * the Anthropic API specifically (not the claude-cli fallback the render
 * pipeline's resolvers use) because it's multimodal — sampled frames are
 * the only way to see on-screen text/overlays/memes the transcript can't.
 *
 * FormatSchema's cross-reference rules (an event's `roleId` must name a
 * real anchor in the same block; a semantic anchor's window must reference
 * a LITERAL anchor) live in a `.superRefine`, which cannot be expressed as
 * a JSON schema constraint for structured outputs — nothing can guarantee
 * a model invents self-consistent ids on the first try. So this is a
 * plain-JSON prompt (mirroring resolvers/claudeCli.ts's extractJson
 * approach) validated with FormatSchema.safeParse after the fact, with the
 * validation errors fed back for the model to repair — generate, validate,
 * repair, same idea as resolveRoles' confidence-threshold fallback, just
 * applied to a whole document instead of one anchor.
 */

const DEFAULT_MODEL = "claude-opus-4-8";
/** Bounds the multimodal call's cost/context against a long or fast-cut
 *  source. Higher than analyze()'s old 20-shot-frame cap because the
 *  candidate pool now includes analyze()'s denser sampling (frames caught
 *  WITHIN a shot, not just at cuts) — a continuous-take reel with only 1-2
 *  shots still needs enough frames to see overlay/label/blur choreography
 *  that never coincides with a scene change. */
const MAX_FRAMES = 40;
const MAX_REPAIR_ROUNDS = 2;
/** Shared by adaptive thinking and the output JSON — a full multi-block
 *  format (many slots/anchors/events) can run past 8000 tokens combined,
 *  which truncates the JSON mid-array and fails with a raw parse error
 *  instead of a clear "ran out of budget" one. */
const MAX_TOKENS = 24000;

/** Every niche already in use across formats/*.json, for the synthesis
 *  prompt to reuse instead of minting a near-duplicate (e.g. "Fitness"
 *  alongside an existing "Gym"). Skips any format that fails to load
 *  rather than failing synthesis over an unrelated broken file. */
const getExistingNiches = (): string[] => {
  const niches = new Set<string>();
  for (const id of listFormats()) {
    try {
      niches.add(loadFormat(id).niche);
    } catch {
      // unrelated format is broken/mid-edit — irrelevant to niche reuse
    }
  }
  return Array.from(niches).sort();
};

/** One frame worth showing the model, normalized from either a Shot
 *  (labeled by its shot index/span) or a DenseFrame (labeled by timestamp
 *  only) into one chronological list. */
type SampledFrame = { atSec: number; frame: string; label: string };

/** Merges shot-midpoint frames with analyze()'s denser sampling into one
 *  chronological, deduped list, then downsamples evenly (not truncated) to
 *  MAX_FRAMES so late-video material isn't silently dropped. */
const selectFramesForSynthesis = (analysis: Analysis): SampledFrame[] => {
  const shotFrames: SampledFrame[] = analysis.shots.map((s) => ({
    atSec: (s.startSec + s.endSec) / 2,
    frame: s.frame,
    label: `Frame for shot ${s.index} (${s.startSec.toFixed(2)}s-${s.endSec.toFixed(2)}s):`,
  }));
  const denseFrames: SampledFrame[] = analysis.denseFrames.map((d) => ({
    atSec: d.atSec,
    frame: d.frame,
    label: `Frame at ${d.atSec.toFixed(2)}s:`,
  }));
  const merged = [...shotFrames, ...denseFrames].sort((a, b) => a.atSec - b.atSec);
  // A dense sample can land right on a shot's own midpoint — keep just one
  // (shotFrames were spread first, so a tie keeps the shot-labeled entry,
  // which is marginally more informative).
  const deduped = merged.filter((f, i) => i === 0 || f.atSec - merged[i - 1].atSec > 0.05);
  if (deduped.length <= MAX_FRAMES) return deduped;
  const stride = deduped.length / MAX_FRAMES;
  return Array.from({ length: MAX_FRAMES }, (_, i) => deduped[Math.floor(i * stride)]);
};

/**
 * The FormatSchema contract, in prose — the model never sees the zod
 * source, so every field, every union variant, and the closed lists of
 * real renderer components/transitions it may reference are spelled out
 * in formatContract.md, which lives next to this file so it's easy to
 * find from either consumer. Read once per process; there's exactly one
 * copy, shared with the reel-to-template skill (an agent authoring
 * draft.json by hand instead of through this API call) so the two never
 * drift out of sync with each other OR with schemas.ts/EdlVideo.tsx.
 */
const FORMAT_CONTRACT = fs.readFileSync(
  path.join(repoRoot, "src/backend/authoring/formatContract.md"),
  "utf8",
);

/** Rules that WILL be checked and must hold — kept here (not in the
 *  shared .md) since these are specifically about what FAILS validation,
 *  which only matters to the model generating a draft, not to a human or
 *  agent reading the contract as reference documentation. */
const VALIDATION_RULES = `Rules that WILL be checked and must hold:
- every block's "videoSlot" names one of that block's own "slots"
- every anchor "id" is unique within its block; every event "id" is unique across the whole format
- a semantic anchor's "window.afterAnchor"/"beforeAnchor" must each name a LITERAL anchor id in the SAME block (never itself, never a semantic anchor, never cross-block)
- every event's "timing.roleId" (and "until.roleId" if present) must name a real anchor id in that same block
- every "states[].trigger.roleId" (when its "kind" is "role") must also name a real anchor id in that same block; "states[].trigger.kind" may never be "sequence"
- "broll" blocks have no "anchors" and no "captions": true
- only use the exact component names listed above, spelled exactly that way`;

const buildSynthesisPrompt = (
  analysis: Analysis,
  selectedFrames: SampledFrame[],
  existingNiches: string[],
): string => {
  const wordLines = analysis.words
    .map((w) => `${w.startSec.toFixed(2)}-${w.endSec.toFixed(2)} ${JSON.stringify(w.text)}`)
    .join("\n");
  const shotLines = analysis.shots
    .map((s) => `shot ${s.index}: ${s.startSec.toFixed(2)}s-${s.endSec.toFixed(2)}s`)
    .join("\n");
  const totalCandidates = analysis.shots.length + analysis.denseFrames.length;
  const framesNote =
    selectedFrames.length < totalCandidates
      ? ` (downsampled evenly from ${totalCandidates} candidates)`
      : "";

  const nicheNote =
    existingNiches.length > 0
      ? `EXISTING NICHES — reuse one of these for the format's "niche" field if it genuinely correlates with this reel's subject; only invent a new niche if none of them fit:\n${existingNiches.join(", ")}\nA new niche must still be a SINGLE WORD, simple and generic (e.g. "Gym", "Neuroscience", "Travel", "Work") — not a phrase.`
      : `No existing niches yet — pick a SINGLE WORD, simple and generic niche (e.g. "Gym", "Neuroscience", "Travel", "Work").`;

  return `You are reverse-engineering a short-form vertical video (${analysis.durationSec.toFixed(1)}s, ${analysis.width}x${analysis.height}) into a reusable FORMAT for "Katalab", a video-templating engine. A format captures a proven structure — the beats, the timing, the overlay/sfx moments, AND their exact on-screen positions/animations — as data, so a different creator can film their OWN content into the same slots and get a video out that looks EXACTLY like this reference, just with their own footage.

${FORMAT_CONTRACT}

${VALIDATION_RULES}

${nicheNote}

TRANSCRIPT — one word per line, start-end seconds relative to the clip:
${wordLines || "(no speech detected — this may be a silent/music-driven format; author it with mostly \"broll\" blocks)"}

SHOTS — ${analysis.shots.length} scene-cut boundaries detected:
${shotLines}

FRAMES — ${selectedFrames.length} frames attached below, in chronological order${framesNote}. These are sampled MUCH more densely than the shot list above specifically so you can see choreography that happens WITHIN a single shot — a card popping in, a blurred placeholder becoming sharp, a label changing color — not just at hard cuts. Study consecutive frames for exactly this: when an element FIRST appears, where it sits (measure its box as a fraction of the frame for "layout"), and any moment its look changes (blur/color/label) that "states" should capture, tied to the word being spoken at that instant.

Study the transcript for the spoken structure (a hook line, then each beat, then a call to action) and the frames for ANY on-screen text, memes, screen-recordings, title cards, or overlays, exactly where they sit on screen, and when/how they appear or change relative to the shots/transcript — that visual layer is exactly what "events" (and their "layout"/"states") should capture.

Respond with ONLY the JSON object described above — no markdown code fences, no other text before or after it.`;
};

const buildRepairPrompt = (previousJsonText: string, errorText: string): string =>
  `Your previous response did not validate. Fix ONLY what's wrong below; keep everything else exactly the same.

Validation errors:
${errorText}

Your previous response:
${previousJsonText}

Respond with ONLY the corrected JSON object (the same {"rationale", "format"} shape) — no markdown code fences, no other text.`;

const extractJsonObject = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in model output: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
};

/** Loose shape checked before the strict FormatSchema pass, so a
 *  malformed-JSON or wrong-top-level-shape response gets a targeted repair
 *  prompt instead of a wall of FormatSchema errors about a document that
 *  isn't even in the right envelope yet. */
const RawOutputSchema = z.object({ rationale: z.string(), format: z.unknown() });

export const synthesize = async (draftId: string, analysis: Analysis): Promise<Draft> => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "synthesize: requires ANTHROPIC_API_KEY (put it in .env) — format synthesis is multimodal " +
        "(it reads sampled frames) and needs the Anthropic API; the render pipeline itself stays keyless.",
    );
  }
  const client = new Anthropic();
  // `||` (not `??`) deliberately — an EDITABLE_LLM_MODEL="" in .env is "not
  // set", not "use an empty model string" (which the API rejects outright).
  const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;
  const dir = authoringDir(draftId);

  const selectedFrames = selectFramesForSynthesis(analysis);
  const imageBlocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = selectedFrames.flatMap(
    (f) => {
      const framePath = path.join(dir, f.frame);
      if (!fs.existsSync(framePath)) return [];
      const data = fs.readFileSync(framePath).toString("base64");
      return [
        { type: "text", text: f.label },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
      ];
    },
  );

  let content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
    { type: "text", text: buildSynthesisPrompt(analysis, selectedFrames, getExistingNiches()) },
    ...imageBlocks,
  ];

  for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt++) {
    const isLastAttempt = attempt === MAX_REPAIR_ROUNDS;
    // Streamed, not create(): the SDK requires it once a request may run
    // past 10 minutes, which a MAX_TOKENS-sized adaptive-thinking response
    // from a slower model can.
    const response = await client.messages
      .stream({
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content }],
      })
      .finalMessage();
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      if (isLastAttempt) throw new Error("synthesize: model response had no text content");
      content = [{ type: "text", text: "Your previous response had no text content. Respond with ONLY the JSON object." }];
      continue;
    }
    const rawText = textBlock.text;

    if (response.stop_reason === "max_tokens") {
      if (isLastAttempt) {
        throw new Error(
          `synthesize: response was cut off at the ${MAX_TOKENS}-token budget before the JSON finished — ` +
            "the format was too large to fit alongside the model's reasoning.",
        );
      }
      content = [
        {
          type: "text",
          text: "Your previous response was cut off before the JSON finished (ran out of output budget). Respond again with ONLY the complete JSON object, keeping it as concise as possible — trim rationale length and any verbose instructions text if needed, but keep every required field.",
        },
      ];
      continue;
    }

    let rawParsed: unknown;
    try {
      rawParsed = extractJsonObject(rawText);
    } catch (err) {
      if (isLastAttempt) throw err;
      content = [{ type: "text", text: buildRepairPrompt(rawText, (err as Error).message) }];
      continue;
    }

    const raw = RawOutputSchema.safeParse(rawParsed);
    if (!raw.success) {
      if (isLastAttempt) {
        throw new Error(
          `synthesize: model output didn't match the {rationale, format} envelope:\n${z.prettifyError(raw.error)}`,
        );
      }
      content = [{ type: "text", text: buildRepairPrompt(rawText, z.prettifyError(raw.error)) }];
      continue;
    }

    const candidate = {
      draftId,
      sourceUrl: analysis.sourceUrl,
      createdAt: new Date().toISOString(),
      rationale: raw.data.rationale,
      format: raw.data.format,
    };
    const validated = DraftSchema.safeParse(candidate);
    if (validated.success) return validated.data;

    if (isLastAttempt) {
      throw new Error(
        `synthesize: draft format failed validation after ${MAX_REPAIR_ROUNDS} repair attempt(s):\n${z.prettifyError(validated.error)}`,
      );
    }
    content = [{ type: "text", text: buildRepairPrompt(JSON.stringify(rawParsed), z.prettifyError(validated.error)) }];
  }

  throw new Error("synthesize: unreachable");
};

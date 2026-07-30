import fs from "node:fs";
import path from "node:path";
import { withTimeout } from "./withTimeout";

/**
 * Shared Gemini `generateContent` plumbing — factored out of gemini.ts
 * (which only ever needed an image response) so generation/modelShots.ts
 * can reuse the same request/inline-image machinery for BOTH an image
 * response (a generated still) and a plain text response (identityPrep.ts's
 * pose classification), instead of duplicating the fetch/error-handling
 * boilerplate a second time.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// `||` (not `??`), matching this repo's other env-model overrides — an
// empty string in .env means "not set", not "use an empty model string".
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image";
// "gemini-3-pro-preview" (the old default), "gemini-3-pro", and
// "gemini-2.5-pro" all 404/"no longer available to new users" on this key —
// confirmed by direct generateContent probes, not just ListModels (which
// still lists some of them despite being unreachable). "gemini-3.1-flash-lite"
// is confirmed reachable and is more than enough for this file's own text
// use (identityPrep.ts's pose classification — a small structured-JSON
// call, not a task that needs the heaviest available model).
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite";

const readImageAsInlineData = (absPath: string): { mimeType: string; data: string } => {
  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return { mimeType, data: fs.readFileSync(absPath).toString("base64") };
};

type GeminiInlineData = { mimeType?: string; mime_type?: string; data: string };
type GeminiPart = { text?: string; inlineData?: GeminiInlineData; inline_data?: GeminiInlineData };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };

const requireApiKey = (): string => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini generation requires GEMINI_API_KEY (put it in .env)");
  return apiKey;
};

/** Output geometry pinned into the request — see generateImage's own doc
 *  comment for why this can't be left to the model's default. */
export type ImageConfig = { aspectRatio?: string; imageSize?: string };

const callGemini = async (
  model: string,
  prompt: string,
  refImagePaths: string[],
  responseModalities: string[] | undefined,
  imageConfig?: ImageConfig,
): Promise<GeminiResponse> => {
  const apiKey = requireApiKey();
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [{ text: prompt }];
  for (const imagePath of refImagePaths) {
    const { mimeType, data } = readImageAsInlineData(imagePath);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }

  const generationConfig = {
    ...(responseModalities ? { responseModalities } : {}),
    ...(imageConfig ? { imageConfig } : {}),
  };

  // Two independent layers, not redundant: AbortSignal is the "real"
  // cancellation (frees the socket) but was observed NOT firing reliably
  // on its own this session (a run stalled 20+ minutes with both this and
  // faceCheck.ts's SDK timeout supposedly active) — withTimeout is a hard
  // backstop that settles this call's own promise on schedule regardless
  // of whether the abort actually propagated through fetch/undici.
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        }),
        signal: AbortSignal.timeout(115_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`gemini ${model}: request timed out after 115s (no response — likely a stuck connection, not a slow one)`);
      }
      throw err;
    }
  };
  const response = await withTimeout(doFetch(), 120_000, `gemini ${model}`);
  const json = await withTimeout(response.json(), 30_000, `gemini ${model} (parsing response body)`);
  if (!response.ok) {
    throw new Error(`gemini ${model}: API error ${response.status}: ${JSON.stringify(json).slice(0, 2000)}`);
  }
  return json as GeminiResponse;
};

/** Generates one image from a prompt + up to `maxRefs` reference images
 *  (model cap: 14 total references, 6 at "high fidelity"), returning its
 *  raw bytes. Throws if the response has no image part.
 *
 * `imageConfig` pins the output aspect ratio/resolution explicitly. Left
 * unset, the model picks its own default geometry — and this pipeline's
 * downstream `resizeCover` would then cover-crop whatever came back to
 * fit the target canvas, silently re-introducing exactly the framing
 * drift a plate-anchored generation call is meant to eliminate (the
 * composition the model was PAID to produce gets clipped again on our
 * side). Callers doing plate-anchored subject-into-scene generation
 * should always pass `imageConfig: { aspectRatio: "9:16", imageSize: "2K" }`
 * (or the target format's own aspect) so the returned frame already
 * matches the canvas and resizeCover is a no-op scale, not a crop. */
export const generateImage = async (
  prompt: string,
  refImagePaths: string[],
  maxRefs = 5,
  imageConfig?: ImageConfig,
): Promise<Buffer> => {
  const json = await callGemini(GEMINI_IMAGE_MODEL, prompt, refImagePaths.slice(0, maxRefs), ["IMAGE"], imageConfig);
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find((p) => p.inlineData?.data ?? p.inline_data?.data);
  const inline = imagePart?.inlineData ?? imagePart?.inline_data;
  if (!inline?.data) {
    throw new Error(`gemini image generation: no image in response: ${JSON.stringify(json).slice(0, 2000)}`);
  }
  return Buffer.from(inline.data, "base64");
};

/** Plain text completion (identityPrep.ts's pose classification) — no
 *  image output, just whatever text Gemini returns for the prompt. */
export const generateText = async (prompt: string, refImagePaths: string[] = []): Promise<string> => {
  const json = await callGemini(GEMINI_TEXT_MODEL, prompt, refImagePaths, undefined);
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const text = responseParts.map((p) => p.text ?? "").join("");
  if (!text.trim()) {
    throw new Error(`gemini text generation: empty response: ${JSON.stringify(json).slice(0, 2000)}`);
  }
  return text;
};

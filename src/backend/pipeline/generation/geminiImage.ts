import fs from "node:fs";
import path from "node:path";

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
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3-pro-preview";

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

const callGemini = async (
  model: string,
  prompt: string,
  refImagePaths: string[],
  responseModalities: string[] | undefined,
): Promise<GeminiResponse> => {
  const apiKey = requireApiKey();
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [{ text: prompt }];
  for (const imagePath of refImagePaths) {
    const { mimeType, data } = readImageAsInlineData(imagePath);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }

  const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      ...(responseModalities ? { generationConfig: { responseModalities } } : {}),
    }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`gemini ${model}: API error ${response.status}: ${JSON.stringify(json).slice(0, 2000)}`);
  }
  return json as GeminiResponse;
};

/** Generates one image from a prompt + up to `maxRefs` reference images,
 *  returning its raw bytes. Throws if the response has no image part. */
export const generateImage = async (
  prompt: string,
  refImagePaths: string[],
  maxRefs = 5,
): Promise<Buffer> => {
  const json = await callGemini(GEMINI_IMAGE_MODEL, prompt, refImagePaths.slice(0, maxRefs), ["IMAGE"]);
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationProvider, GenerationRequest, animateStillToClip } from "./provider";

/**
 * Real generation provider (vs. provider.ts's zero-spend fallback): calls
 * Gemini's image model ("Nano Banana Pro") with the job's identity photos
 * as reference, asking it to recreate the person in the format's
 * StyleProfile environment/lighting — an identity-preserving still. That
 * still is then animated into the slot's durationSec clip via the same
 * Ken-Burns+grade helper the fallback stub uses, so the two providers
 * differ only in WHERE the still comes from (an unmodified photo vs. a
 * generated composite), not in how it becomes a clip.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// `||` (not `??`), matching this repo's other env-model overrides — an
// empty string in .env means "not set", not "use an empty model string".
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image";

const buildPrompt = (req: GenerationRequest): string => {
  const { environment, lighting, grade } = req.styleProfile;
  const gradeNote =
    grade?.temperatureShift !== undefined && grade.temperatureShift < 0
      ? "a cool, desaturated color grade"
      : "a warm color grade";
  return (
    `Photorealistic portrait recreation. The attached reference photo(s) show a specific real person — ` +
    `preserve their exact facial identity, likeness, hairstyle, and clothing unchanged; do not invent a ` +
    `different person. Recreate that same person, in their own clothing, in this pose/shot: ${req.shot}. ` +
    `Environment: ${environment}. Lighting: ${lighting}. Overall look: cinematic, photorealistic, ` +
    `${gradeNote}, high contrast, shallow depth of field, 35mm lens.`
  );
};

const readImageAsInlineData = (absPath: string): { mimeType: string; data: string } => {
  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return { mimeType, data: fs.readFileSync(absPath).toString("base64") };
};

type GeminiInlineData = { mimeType?: string; mime_type?: string; data: string };
type GeminiPart = { text?: string; inlineData?: GeminiInlineData; inline_data?: GeminiInlineData };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };

export const geminiGenerationProvider: GenerationProvider = {
  name: "gemini",
  generate: async (req) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("generation provider 'gemini' requires GEMINI_API_KEY (put it in .env)");
    }
    if (req.identityImages.length === 0) {
      throw new Error("gemini generation provider: no identity images to draw from");
    }

    // Up to 3 reference angles — enough for identity, cheap enough on tokens.
    const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
      { text: buildPrompt(req) },
    ];
    for (const imagePath of req.identityImages.slice(0, 3)) {
      const { mimeType, data } = readImageAsInlineData(imagePath);
      parts.push({ inline_data: { mime_type: mimeType, data } });
    }

    const response = await fetch(
      `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      },
    );
    const json = await response.json();
    if (!response.ok) {
      throw new Error(
        `gemini generation provider: API error ${response.status}: ${JSON.stringify(json).slice(0, 2000)}`,
      );
    }

    const responseParts = (json as GeminiResponse).candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((p) => p.inlineData?.data ?? p.inline_data?.data);
    const inline = imagePart?.inlineData ?? imagePart?.inline_data;
    if (!inline?.data) {
      throw new Error(
        `gemini generation provider: no image in response: ${JSON.stringify(json).slice(0, 2000)}`,
      );
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-gemini-"));
    try {
      const stillPath = path.join(workDir, "still.png");
      fs.writeFileSync(stillPath, Buffer.from(inline.data, "base64"));
      animateStillToClip(stillPath, {
        durationSec: req.durationSec,
        width: req.width,
        height: req.height,
        fps: req.fps,
        grade: req.styleProfile.grade,
        outPath: req.outPath,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  },
};

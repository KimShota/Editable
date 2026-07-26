import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiggsfieldClient } from "@higgsfield/client";
import { GenerationProvider, GenerationRequest, animateStillToClip } from "./provider";

/**
 * Real generation provider (vs. provider.ts's zero-spend fallback and
 * gemini.ts's Gemini-backed one): calls Higgsfield's Soul text-to-image
 * model with the job's identity photo as an `image_reference`, asking it
 * to recreate the person in the format's StyleProfile environment/lighting
 * — an identity-preserving still. That still is then animated into the
 * slot's durationSec clip via the same Ken-Burns+grade helper the other
 * providers use, so all three differ only in WHERE the still comes from.
 */

// Soul only accepts one of these 13 fixed width_and_height presets — pick
// whichever has the closest aspect ratio to the format's actual dimensions.
const SOUL_SIZES: ReadonlyArray<{ label: string; width: number; height: number }> = [
  { label: "2048x1152", width: 2048, height: 1152 },
  { label: "2048x1536", width: 2048, height: 1536 },
  { label: "2016x1344", width: 2016, height: 1344 },
  { label: "1696x960", width: 1696, height: 960 },
  { label: "1632x1088", width: 1632, height: 1088 },
  { label: "1152x2048", width: 1152, height: 2048 },
  { label: "1536x2048", width: 1536, height: 2048 },
  { label: "1344x2016", width: 1344, height: 2016 },
  { label: "960x1696", width: 960, height: 1696 },
  { label: "1088x1632", width: 1088, height: 1632 },
  { label: "1536x1536", width: 1536, height: 1536 },
  { label: "1536x1152", width: 1536, height: 1152 },
  { label: "1152x1536", width: 1152, height: 1536 },
];

const closestSoulSize = (width: number, height: number): string => {
  const targetRatio = width / height;
  let best = SOUL_SIZES[0];
  let bestDiff = Infinity;
  for (const size of SOUL_SIZES) {
    const diff = Math.abs(size.width / size.height - targetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  return best.label;
};

const buildPrompt = (req: GenerationRequest): string => {
  const { environment, lighting, grade } = req.styleProfile;
  const gradeNote =
    grade?.temperatureShift !== undefined && grade.temperatureShift < 0
      ? "a cool, desaturated color grade"
      : "a warm color grade";
  return (
    `Photorealistic portrait recreation. The attached reference photo shows a specific real person — ` +
    `preserve their exact facial identity, likeness, hairstyle, and clothing unchanged; do not invent a ` +
    `different person. Recreate that same person, in their own clothing, in this pose/shot: ${req.shot}. ` +
    `Environment: ${environment}. Lighting: ${lighting}. Overall look: cinematic, photorealistic, ` +
    `${gradeNote}, high contrast, shallow depth of field, 35mm lens.`
  );
};

const imageFormat = (absPath: string): "png" | "webp" | "jpeg" => {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".webp") return "webp";
  return "jpeg";
};

// One client (and its axios instance) reused across calls within the
// process rather than reconstructed per generate() — mirrors how the
// other pipeline stages hold a single provider instance for their run.
let cachedClient: HiggsfieldClient | null = null;
const getClient = (): HiggsfieldClient => {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "generation provider 'higgsfield' requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (put them in .env)",
    );
  }
  cachedClient = new HiggsfieldClient({ apiKey, apiSecret });
  return cachedClient;
};

export const higgsfieldGenerationProvider: GenerationProvider = {
  name: "higgsfield",
  generate: async (req) => {
    if (req.identityImages.length === 0) {
      throw new Error("higgsfield generation provider: no identity images to draw from");
    }
    const client = getClient();

    // Seed picks which reference photo to use, same convention as the
    // fallback provider — several generated slots in one job then draw
    // from different angles rather than all reusing the same photo.
    const imagePath = req.identityImages[req.seed % req.identityImages.length];
    const imageUrl = await client.uploadImage(fs.readFileSync(imagePath), imageFormat(imagePath));

    const jobSet = await client.generate(
      "/v1/text2image/soul",
      {
        prompt: buildPrompt(req),
        width_and_height: closestSoulSize(req.width, req.height),
        quality: "720p",
        batch_size: 1,
        image_reference: { type: "image_url", image_url: imageUrl },
      },
      { withPolling: true },
    );

    if (!jobSet.isCompleted) {
      const statuses = jobSet.jobs.map((j) => j.status).join(", ") || "unknown";
      throw new Error(`higgsfield generation provider: job did not complete (status: ${statuses})`);
    }
    const stillUrl = jobSet.jobs[0]?.results?.raw.url;
    if (!stillUrl) {
      throw new Error("higgsfield generation provider: completed job has no image result");
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-higgsfield-"));
    try {
      const stillPath = path.join(workDir, "still.png");
      const imgRes = await fetch(stillUrl);
      if (!imgRes.ok) {
        throw new Error(`higgsfield generation provider: failed to download generated still (${imgRes.status})`);
      }
      fs.writeFileSync(stillPath, Buffer.from(await imgRes.arrayBuffer()));
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

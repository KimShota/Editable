import { HiggsfieldClient } from "@higgsfield/client";

/**
 * Shared "generate one empty backdrop image via Higgsfield Soul" helper —
 * used both by higgsfield.ts (the montage insert's backdrop) and
 * backgroundReplace.ts (the talking-head blocks' shared office backdrop).
 * No person, no image_reference, no identity risk: the request describes
 * only an empty environment, and the real subject is composited in
 * afterward via matte.ts.
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

export const closestSoulSize = (width: number, height: number): { label: string; width: number; height: number } => {
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
  return best;
};

// One client (and its axios instance) reused across calls within the
// process rather than reconstructed per call — mirrors how the other
// pipeline stages hold a single provider instance for their run.
let cachedClient: HiggsfieldClient | null = null;
const getClient = (): HiggsfieldClient => {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Higgsfield backdrop generation requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (put them in .env)");
  }
  cachedClient = new HiggsfieldClient({ apiKey, apiSecret });
  return cachedClient;
};

/** No person, no pose, no framing — those come from compositing the real
 *  subject in afterward. Just the empty set the format's StyleProfile
 *  describes, in the given shot context. */
export const buildBackdropPrompt = (environment: string, lighting: string, shotContext: string): string =>
  `An empty, unoccupied ${shotContext} — no people, no person, no human figure anywhere in frame. ` +
  `Environment: ${environment}. Lighting: ${lighting}. Plain, uncluttered, photorealistic, ` +
  `cinematic, high detail. The scene is completely empty and waiting for a subject to be placed into it.`;

/** Generates one empty backdrop image and returns its raw bytes at
 *  whichever Soul preset size is closest to the requested aspect ratio
 *  (see closestSoulSize — callers needing exact dimensions should
 *  resizeCover the result). */
export const generateBackdropImage = async (
  prompt: string,
  width: number,
  height: number,
): Promise<{ bytes: Buffer; size: { label: string; width: number; height: number } }> => {
  const client = getClient();
  const size = closestSoulSize(width, height);

  const jobSet = await client.generate(
    "/v1/text2image/soul",
    {
      prompt,
      width_and_height: size.label,
      quality: "720p",
      batch_size: 1,
    },
    { withPolling: true },
  );

  if (!jobSet.isCompleted) {
    const statuses = jobSet.jobs.map((j) => j.status).join(", ") || "unknown";
    throw new Error(`higgsfield backdrop generation: job did not complete (status: ${statuses})`);
  }
  const url = jobSet.jobs[0]?.results?.raw.url;
  if (!url) {
    throw new Error("higgsfield backdrop generation: completed job has no image result");
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`higgsfield backdrop generation: failed to download image (${res.status})`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), size };
};

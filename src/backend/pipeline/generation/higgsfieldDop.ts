import { HiggsfieldClient } from "@higgsfield/client";
import fs from "node:fs";

/**
 * Higgsfield's DoP image2video (`/v1/image2video/dop`) — real motion for
 * ONE already-generated still, used by modelShots.ts's triptych builder
 * for panels a Ken-Burns push can't approximate (measured: the reference
 * reel's cash panel moves ~24 luma/frame, a push moves ~1). Same
 * HiggsfieldClient/`.generate()` v1 pattern already used by
 * higgsfieldBackdrop.ts (there's also a newer v2 `.subscribe()` client in
 * this same package, but the v1 client is the one already proven working
 * in this codebase, so this reuses it rather than introducing a second
 * calling convention for one more endpoint).
 */

let cachedClient: HiggsfieldClient | null = null;
const getClient = (): HiggsfieldClient => {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Higgsfield DoP animation requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (put them in .env)");
  }
  cachedClient = new HiggsfieldClient({ apiKey, apiSecret });
  return cachedClient;
};

/** Sends one still through DoP image2video and returns the resulting
 *  video's raw bytes (whatever container/codec Higgsfield returns —
 *  written straight to disk by the caller, then read by ffmpeg like any
 *  other input, no transcoding needed here). */
export const animateStillWithDop = async (
  stillImagePath: string,
  prompt: string,
  opts: { model?: "dop-lite" | "dop-preview" | "dop-turbo"; seed?: number } = {},
): Promise<Buffer> => {
  const client = getClient();
  const imageUrl = await client.uploadImage(fs.readFileSync(stillImagePath), "png");

  const jobSet = await client.generate(
    "/v1/image2video/dop",
    {
      // The installed @higgsfield/client SDK's own TYPE for this field
      // claims 'dop-lite'|'dop-turbo'|'dop-standard' — the LIVE API
      // rejects 'dop-standard' and wants 'dop-preview' instead (confirmed
      // by a direct call: "Input should be 'dop-lite', 'dop-preview' or
      // 'dop-turbo'"). 'dop-lite' is the cheapest of the three actually
      // accepted, matching this format's own cost-conscious defaults
      // elsewhere (Gemini Flash-tier for props, batch pricing preferred).
      model: opts.model ?? "dop-lite",
      prompt,
      input_images: [{ type: "image_url", image_url: imageUrl }],
      seed: opts.seed,
    },
    { withPolling: true },
  );

  if (!jobSet.isCompleted) {
    const statuses = jobSet.jobs.map((j) => j.status).join(", ") || "unknown";
    throw new Error(`higgsfield DoP: job did not complete (status: ${statuses})`);
  }
  const url = jobSet.jobs[0]?.results?.raw.url;
  if (!url) {
    throw new Error("higgsfield DoP: completed job has no video result");
  }

  // Same reasoning as geminiImage.ts's own AbortSignal.timeout: an
  // unbounded fetch can hang forever on a stuck connection instead of
  // failing into the caller's own error handling.
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`higgsfield DoP: failed to download video (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
};

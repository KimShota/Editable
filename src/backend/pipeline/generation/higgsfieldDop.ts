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

/**
 * client.uploadImage() (the SDK's own two-step upload: POST for a presigned
 * S3 URL, then PUT the bytes) is broken in @higgsfield/client 0.2.1 — the
 * latest published version, confirmed no newer release exists. The presigned
 * URL's X-Amz-SignedHeaders includes "x-amz-tagging", and
 * /files/generate-upload-url's response carries the exact header set the PUT
 * needs (`upload_headers: { Content-Type, x-amz-tagging }`) — but
 * uploadImage()'s PUT only ever sends Content-Type, silently dropping
 * upload_headers entirely. Every signed header must be present on the
 * request for SigV4 to validate, so this omission makes S3 reject EVERY
 * upload with 403 SignatureDoesNotMatch — confirmed directly against the
 * live API: the SDK's own request fails regardless of client (axios/fetch/
 * curl all fail identically), while replaying the API's own upload_headers
 * on the PUT succeeds. Nothing to do with credentials, credits, or plan.
 * This bypasses uploadImage() and redoes the same two-step flow by hand,
 * honoring upload_headers instead of hardcoding just Content-Type.
 */
const uploadStillForDop = async (imageBuffer: Buffer, format: string): Promise<string> => {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Higgsfield DoP animation requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (put them in .env)");
  }

  const linkRes = await fetch("https://platform.higgsfield.ai/files/generate-upload-url", {
    method: "POST",
    headers: { "hf-api-key": apiKey, "hf-secret": apiSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: `image/${format}` }),
  });
  if (!linkRes.ok) {
    throw new Error(`higgsfield DoP: failed to get upload URL (${linkRes.status})`);
  }
  const { upload_url, public_url, upload_headers } = (await linkRes.json()) as {
    upload_url: string;
    public_url: string;
    upload_headers: Record<string, string>;
  };

  const putRes = await fetch(upload_url, { method: "PUT", body: new Uint8Array(imageBuffer), headers: upload_headers });
  if (!putRes.ok) {
    throw new Error(`higgsfield DoP: image upload failed (${putRes.status}) — ${await putRes.text()}`);
  }
  return public_url;
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
  const imageUrl = await uploadStillForDop(fs.readFileSync(stillImagePath), "png");

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

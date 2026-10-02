import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CostSink } from "../cost/ledger";

/**
 * Higgsfield's model API (https://api.higgsfield.ai, docs.higgsfield.ai):
 * one calling convention for every hosted model (Seedance, Kling, …).
 * Upload inputs to a presigned URL, ask the estimate endpoint what the
 * request costs, submit, poll the request until it is terminal, download.
 *
 * The request id is handed to `onSubmitted` before polling starts, so a
 * caller can persist it and resume polling after a crash instead of paying
 * for the same generation twice (`waitFor`).
 *
 * The older platform.higgsfield.ai client (pipeline/generation/higgsfieldDop.ts)
 * stays as it is; the same key pair works on both hosts.
 */

const API = "https://api.higgsfield.ai";

const auth = (): string => {
  const id = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!id || !secret) throw new Error("higgsfield: HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET must be set");
  return `Key ${id}:${secret}`;
};

const request = async (method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: auth(), "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`higgsfield ${method} ${path}: ${res.status} ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : {};
};

const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp4": "video/mp4" };

/** Uploads a local file and returns the public URL a model input can take. */
export const uploadFile = async (filePath: string): Promise<string> => {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`higgsfield: cannot upload ${ext} files (images, wav audio and mp4 only)`);
  const link = (await request("POST", "/files/generate-upload-url", { content_type: contentType })) as {
    public_url: string;
    upload_url: string;
    upload_headers: Record<string, string>;
  };
  const put = await fetch(link.upload_url, { method: "PUT", body: new Uint8Array(fs.readFileSync(filePath)), headers: link.upload_headers });
  if (!put.ok) throw new Error(`higgsfield upload: ${put.status} ${(await put.text()).slice(0, 500)}`);
  return link.public_url;
};

/**
 * Seedance bills video tokens, not a flat price, so its estimate endpoint
 * answers with a pricing description instead of a number. Its stated formula:
 * tokens = ceil(width × height × seconds × 24 / 1024), $0.0214 per 1,000 at
 * 480p/720p and $0.0234 at 1080p (image and audio references are free).
 */
const SEEDANCE_SIZES: Record<string, Record<string, [number, number]>> = {
  "480p": { "9:16": [480, 864], "16:9": [864, 480], "1:1": [640, 640] },
  "720p": { "9:16": [720, 1280], "16:9": [1280, 720], "1:1": [960, 960] },
  "1080p": { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1440, 1440] },
};
export const seedanceUsd = (input: Record<string, unknown>): number => {
  const resolution = String(input.resolution ?? "720p");
  const size = SEEDANCE_SIZES[resolution]?.[String(input.aspect_ratio ?? "16:9")];
  if (!size) throw new Error(`higgsfield: no Seedance price for ${resolution} ${String(input.aspect_ratio)}`);
  const tokens = Math.ceil((size[0] * size[1] * Number(input.duration ?? 5) * 24) / 1024);
  return (tokens / 1000) * (resolution === "1080p" ? 0.0234 : 0.0214);
};

/** What a request would cost, in USD: the estimate endpoint's number, or the
 *  published token formula for models that only describe their pricing. */
export const estimateUsd = async (endpoint: string, input: Record<string, unknown>): Promise<number> => {
  const res = (await request("POST", `/estimate/${endpoint}`, input)) as { type: string; usd?: string };
  if (res.type === "estimate" && res.usd !== undefined) return Number(res.usd);
  if (endpoint.startsWith("bytedance/seedance-")) return seedanceUsd(input);
  throw new Error(`higgsfield: no estimate for ${endpoint} (${JSON.stringify(res).slice(0, 300)})`);
};

type Status = { status: "queued" | "in_progress" | "completed" | "failed" | "nsfw"; request_id: string; video?: { url: string }; images?: { url: string }[]; error?: string };

/** Polls a submitted request until it is terminal; returns the output URL. */
export const waitFor = async (requestId: string, timeoutMs = 20 * 60_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let delay = 4_000;
  for (;;) {
    const s = (await request("GET", `/requests/${requestId}/status`)) as Status;
    if (s.status === "completed") {
      const url = s.video?.url ?? s.images?.[0]?.url;
      if (!url) throw new Error(`higgsfield ${requestId}: completed without an output`);
      return url;
    }
    if (s.status === "failed" || s.status === "nsfw") throw new Error(`higgsfield ${requestId}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
    if (Date.now() > deadline) throw new Error(`higgsfield ${requestId}: still ${s.status} after ${Math.round(timeoutMs / 60_000)} min`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
};

export const download = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`higgsfield download: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Estimate, submit, wait, download. The estimate is what the ledger records
 * (the API charges on success only; a failed or moderated request is refunded).
 */
export const generate = async (
  endpoint: string,
  input: Record<string, unknown>,
  opts: { costSink?: CostSink; ref?: string; operation: string; onSubmitted?: (requestId: string) => Promise<void> | void },
): Promise<Buffer> => {
  const usd = await estimateUsd(endpoint, input);
  const submitted = (await request("POST", `/${endpoint}`, input, { "Idempotency-Key": randomUUID() })) as Status;
  await opts.onSubmitted?.(submitted.request_id);
  const url = await waitFor(submitted.request_id);
  await opts.costSink?.({ provider: "higgsfield", model: endpoint, operation: opts.operation, units: { seconds: Number(input.duration ?? 0) }, usd, ref: opts.ref });
  return download(url);
};

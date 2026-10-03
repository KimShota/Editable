import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionKeys, recreationKeys, videoJobId } from "../brand/keys";
import { artifactsDir, repoRoot } from "../pipeline/paths";
import { EdlSchema } from "../pipeline/schemas";
import { AI_VIDEO_FORMAT } from "../production/format";
import { addTake } from "../production/takes";
import { AdaptedScriptSchema } from "../recreation/schemas";
import type { Storage } from "../storage";
import { readJson } from "../storageJson";
import type { ProductionOps } from "./deps";

/**
 * Production without a provider: real, tiny videos made with ffmpeg, and
 * every file the real pipeline publishes (storage/brands/<slug>/videos/<card>/,
 * the EDL, jobs/<brand>-<card>/ for the editor, takes, a cost log). Selected
 * by KATALAB_STUB_PROVIDERS=1, for the browser tests and a demo with no API
 * keys. The editor opens these exactly as it opens a real video.
 */

const COLORS = ["0x2563eb", "0x16a34a", "0xc2410c", "0x7c3aed", "0xdb2777", "0x0f766e"];
const SHOT_SEC = 2;
const SIZE = "360x640";

const makeClip = (out: string, color: string, seconds: number): void => {
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${SIZE}:d=${seconds}:r=30`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out],
    { stdio: "ignore" },
  );
};

const withTmp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-stub-video-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Writes a finished stub video for a card whose script exists. Safe to run
 *  again: it replaces the video and keeps the editor's job folder in step. */
export const writeStubVideo = async (storage: Storage, slug: string, cardId: string): Promise<{ shots: string[] }> => {
  const k = productionKeys(slug, cardId);
  const script = AdaptedScriptSchema.parse(await readJson(storage, recreationKeys(slug).script(cardId), "adapted script"));
  const jobId = videoJobId(slug, cardId);
  const prefix = `jobs/${jobId}/generated`;
  const shots = script.shots.map((s) => s.shotId);
  // The job folder first: takes are recorded inside it (as publishToEditor does in the CLI).
  const jobDir = path.join(repoRoot, "jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const edlVideo: unknown[] = [];
  const assets: Record<string, string> = {};
  await withTmp(async (dir) => {
    let at = 0;
    for (const [i, shot] of script.shots.entries()) {
      const file = path.join(dir, `${shot.shotId}.mp4`);
      makeClip(file, COLORS[i % COLORS.length], SHOT_SEC);
      await storage.putFile(k.clip(shot.shotId), file);
      const abs = await storage.localPath(k.clip(shot.shotId));
      const src = `${prefix}/clips/${shot.shotId}.mp4`;
      assets[src] = abs;
      edlVideo.push({ id: `v-${shot.shotId}`, blockId: shot.shotId, src, srcInSec: 0, srcOutSec: SHOT_SEC, srcDurationSec: SHOT_SEC, tlInSec: at, tlOutSec: at + SHOT_SEC, muted: false, speed: 1, volume: 1, zoom: 1 });
      at += SHOT_SEC;
      addTake(jobId, shot.shotId, shot.treatment !== "screen_fill" && shot.treatment !== "text_card", { src, file: abs, durationSec: SHOT_SEC, inSec: 0, createdAt: new Date().toISOString(), origin: "original" });
    }
    const final = path.join(dir, "final.mp4");
    makeClip(final, "0x111827", at);
    await storage.putFile(k.final, final);
  });

  const edl = EdlSchema.parse({ jobId, formatId: AI_VIDEO_FORMAT, fps: 30, width: 360, height: 640, durationSec: shots.length * SHOT_SEC, video: edlVideo, assets });
  const json = JSON.stringify(edl, null, 2);
  await storage.putBuffer(k.edl, Buffer.from(json));

  // The editor's job folder, as production/cli.ts publishToEditor writes it.
  fs.mkdirSync(artifactsDir(jobId), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir(jobId), "edl.json"), json);
  fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ format: AI_VIDEO_FORMAT, bindings: {}, lexicon: [], language: script.language }, null, 2));
  fs.writeFileSync(path.join(jobDir, "ai-video.json"), JSON.stringify({ brand: slug, source: cardId, card: cardId, sourceId: script.sourceId }, null, 2));
  fs.writeFileSync(path.join(jobDir, "project.json"), JSON.stringify({ name: `${slug} · ${script.lines[0]?.text.split(/\s+/).slice(0, 6).join(" ")}` }, null, 2));

  await storage.putBuffer(k.costs, Buffer.from([{ provider: "stub", operation: "voice", usd: 0.3 }, { provider: "stub", operation: "clips", usd: 2.1 }].map((e) => JSON.stringify(e)).join("\n") + "\n"));
  return { shots };
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for the production CLI. `stepMs` paces progress so a test can
 *  watch a run in flight. */
export const stubProduction = (storage: Storage, stepMs = 200): ProductionOps => ({
  estimate: async () => {
    await pause(stepMs);
    return { usd: 12.5, maxUsd: 18 };
  },

  produce: async ({ report }, slug, cardId) => {
    const script = AdaptedScriptSchema.parse(await readJson(storage, recreationKeys(slug).script(cardId), "adapted script"));
    report?.({ stage: "Voicing the script" });
    await pause(stepMs);
    for (let i = 0; i < script.shots.length; i++) {
      report?.({ stage: "Making the clips", done: i, total: script.shots.length, message: script.shots[i].shotId });
      await pause(stepMs);
    }
    report?.({ stage: "Putting the video together" });
    await writeStubVideo(storage, slug, cardId);
    // A card named like a flagged shot makes the run report a QC warning, so
    // the warning path can be tested without a real generation.
    return { flagged: cardId.includes("flag") ? [script.shots[0].shotId] : [] };
  },

  regenEstimate: async () => {
    await pause(stepMs);
    return { usd: 1.25 };
  },

  regenerate: async ({ report }, jobId, clipId) => {
    report?.({ stage: "Generating a new take" });
    await pause(stepMs * 2);
    const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, "jobs", jobId, "ai-video.json"), "utf8")) as { brand: string; card?: string; source: string };
    const cardId = meta.card ?? meta.source;
    const edl = EdlSchema.parse(JSON.parse(fs.readFileSync(path.join(artifactsDir(jobId), "edl.json"), "utf8")));
    const segment = edl.video.find((v) => v.id === clipId);
    if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
    const k = productionKeys(meta.brand, cardId);
    const stamp = Date.now();
    await withTmp(async (dir) => {
      const file = path.join(dir, "take.mp4");
      makeClip(file, COLORS[(stamp / 1000) % COLORS.length | 0], SHOT_SEC);
      const key = `${k.root}/clips/${segment.blockId}.v${stamp}.mp4`;
      await storage.putFile(key, file);
      addTake(jobId, segment.blockId, true, {
        src: `jobs/${jobId}/generated/clips/${segment.blockId}.v${stamp}.mp4`,
        file: await storage.localPath(key),
        durationSec: SHOT_SEC,
        inSec: 0,
        createdAt: new Date().toISOString(),
        origin: "regenerated",
      });
    });
  },
});

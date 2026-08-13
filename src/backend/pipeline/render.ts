import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Edl } from "./types";
import { outDir, publicDir, repoRoot } from "./paths";

/**
 * Module 7 — Render.
 * Feeds the EDL into Remotion, which draws the frames and muxes the audio
 * to produce the final MP4. Purely mechanical: every decision was already
 * made upstream and frozen into the EDL.
 *
 * Staging: Remotion serves media via staticFile() from public/, so the
 * job's assets are copied to the public/-relative paths the EDL references
 * (edl.assets maps src → absolute source path). Carries no timing logic.
 */

export const stageAssets = (edl: Edl): void => {
  for (const [src, from] of Object.entries(edl.assets)) {
    const dest = path.join(publicDir, src);
    const sourceStat = fs.statSync(from);
    // readOrMigrateEdl calls this on EVERY editor page load (see its own
    // doc comment: "idempotent so the Player's staticFile() lookups
    // resolve even after a server restart"), and a job's assets are often
    // hundreds of MB of source footage — re-copying all of it unconditionally
    // on every visit to a job's own editor was pure waste (and, worse, a
    // write burst inside public/, which Next's dev server watches, forcing
    // its own invalidation on top). Same size + same source mtime as what's
    // already staged means nothing to do. copyFileSync does NOT preserve
    // mtime on its own (verified: the destination gets "now"), so this
    // stamps it explicitly below — otherwise every call would see a
    // mismatched mtime and re-copy anyway, defeating the whole check. The
    // 2ms tolerance matters too, not just belt-and-suspenders: utimesSync
    // itself doesn't round-trip sub-millisecond precision exactly (verified:
    // a source mtimeMs of x.9658 came back as x — a strict === here made
    // every call see a "mismatch" and re-copy every single time, silently
    // defeating this entire function).
    let destStat: fs.Stats | undefined;
    try {
      destStat = fs.statSync(dest);
    } catch {
      destStat = undefined;
    }
    if (destStat && destStat.size === sourceStat.size && Math.abs(destStat.mtimeMs - sourceStat.mtimeMs) < 2) continue;

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
    fs.utimesSync(dest, sourceStat.atime, sourceStat.mtime);
  }
};

export const render = (edl: Edl, artifactsJobDir: string): string => {
  stageAssets(edl);

  // The composition's props are { edl }, so wrap the artifact for --props.
  const propsPath = path.join(artifactsJobDir, "props.json");
  fs.writeFileSync(propsPath, JSON.stringify({ edl }));

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${edl.jobId}.mp4`);

  execFileSync(
    "npx",
    ["remotion", "render", "src/backend/index.ts", "EdlVideo", outPath, `--props=${propsPath}`],
    { cwd: repoRoot, stdio: "inherit" },
  );
  return outPath;
};

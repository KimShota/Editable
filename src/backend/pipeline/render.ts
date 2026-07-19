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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
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

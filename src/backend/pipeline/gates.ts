import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { EdlSchema } from "./schemas";
import { Edl } from "./types";

/**
 * Acceptance gates for a rendered export — measured against the reference
 * reel (authoring/draft-baf87683), not aspirational numbers. Run against
 * the FINAL rendered mp4, never an intermediate: grading, compositing and
 * assembly all compound, and only the actual export shows what a viewer
 * sees (a whole earlier session's failure — a montage crushed to
 * mean-luma 3 — passed every intermediate check and only showed up here).
 *
 * Two gates from the original spec (SILHOUETTE-shot brightness, title
 * coverage per shot-type) need shot-type metadata the EDL doesn't carry
 * yet — no SILHOUETTE/ANCHOR/ECU block kind exists until the shot
 * primitives land. They're stubbed with `pass: null` (not applicable)
 * rather than faked against types that don't exist; see backgroundReplace
 * work / the shot-primitive tasks for where they get filled in.
 */

export type GateResult = {
  name: string;
  pass: boolean | null; // null = not applicable yet, not a failure
  measured: string;
  detail?: string;
};

const frameLumaStats = (
  videoPath: string,
  atSec: number,
  w = 180,
  h = 320,
): { mean: number; p5: number; p90: number; p95: number } => {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(Math.max(0, atSec)), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 1024 * 1024 * 10 },
  );
  const hist = new Array(256).fill(0);
  for (const b of raw) hist[b]++;
  const n = raw.length;
  const pct = (p: number) => {
    const target = (n * p) / 100;
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += hist[v];
      if (c >= target) return v;
    }
    return 255;
  };
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  return { mean: sum / n, p5: pct(5), p90: pct(90), p95: pct(95) };
};

/** Gate 1: no 0.5s window anywhere in the export below -60dBFS. Silence
 *  during a broll/montage segment with no music bed WILL trip this — that
 *  is the point (an unfilled music slot is exactly the kind of gap this
 *  is meant to surface), not a bug in the gate. */
const audioFloorGate = (videoPath: string): GateResult => {
  // silencedetect logs to stderr regardless of exit code — spawnSync (not
  // execFileSync) is what gives us that back on the success path too.
  const result = spawnSync(
    "ffmpeg",
    ["-v", "info", "-nostats", "-i", videoPath, "-af", "silencedetect=noise=-60dB:d=0.5", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const stderr = result.stderr ?? "";
  const matches = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const pass = matches.length === 0;
  return {
    name: "audio floor (no 0.5s window < -60dBFS)",
    pass,
    measured: pass ? "no silence >=0.5s detected" : `${matches.length} silence window(s), first at ${matches[0].toFixed(2)}s`,
  };
};

/** Gates 2: per-shot luma sanity — catches a shot crushed to black-on-black
 *  (this shipped once: a montage graded to mean 3.1, spread 3, invisible). */
const shotLumaGates = (videoPath: string, edl: Edl): GateResult[] => {
  return edl.video.map((seg) => {
    const midSec = (seg.tlInSec + seg.tlOutSec) / 2;
    const { mean, p95, p5 } = frameLumaStats(videoPath, midSec);
    const spread = p95 - p5;
    const pass = mean >= 8 && spread >= 40;
    return {
      name: `shot luma sanity: "${seg.blockId}"`,
      pass,
      measured: `mean=${mean.toFixed(1)} spread(p95-p5)=${spread}`,
      detail: pass ? undefined : "mean<8 or spread<40 — likely crushed to a flat black/near-black frame",
    };
  });
};

/** Gate 4 (revised from an absolute shot-count floor, which only made
 *  sense at the reference's own 26.7s runtime): shot density, decoupled
 *  from absolute duration since that's a function of script length.
 *  Counts CutawayOverlay events as their own shots alongside edl.video's
 *  segments — visually, a full-frame cutaway IS a distinct shot even
 *  though it's an overlay layered over its block's video, not a separate
 *  entry in edl.video. Counting only edl.video would make this gate blind
 *  to the entire cut-grid sequencer's contribution to cutting rhythm. */
const shotDensityGate = (edl: Edl): GateResult => {
  const cutaways = edl.overlays.filter((o) => o.component === "CutawayOverlay").length;
  const shots = edl.video.length + cutaways;
  const density = shots / edl.durationSec;
  const pass = density >= 0.5;
  return {
    name: "shot density >= 0.5 shots/sec",
    pass,
    measured: `${edl.video.length} video segments + ${cutaways} cutaways = ${shots} shots / ${edl.durationSec.toFixed(1)}s = ${density.toFixed(2)}/sec`,
  };
};

/** Gate 5: end card stays a brief button, not another full scene. */
const endCardDurationGate = (edl: Edl): GateResult => {
  const endcard = edl.video.find((v) => v.blockId === "end-card");
  if (!endcard) return { name: "end card <= 2.5s", pass: null, measured: "no end-card block in this EDL" };
  const dur = endcard.tlOutSec - endcard.tlInSec;
  return { name: "end card <= 2.5s", pass: dur <= 2.5, measured: `${dur.toFixed(2)}s` };
};

/** Gate 3: SILHOUETTE/ENDCARD brightness. There's no formal per-segment
 *  shot-type tag on the EDL yet (that's the cut-grid sequencer's job —
 *  see the shot-primitive tasks), so this identifies the two blocks that
 *  ARE built as SILHOUETTE-style shots today by blockId — an interim
 *  heuristic, not the real thing, but real enough to catch a regression
 *  in either of them. Extend the list as more SILHOUETTE cutaways land. */
const SILHOUETTE_BLOCK_IDS = new Set(["cinematic-montage"]);
const ENDCARD_BLOCK_IDS = new Set(["end-card"]);

const silhouetteBrightnessGates = (videoPath: string, edl: Edl): GateResult[] =>
  edl.video
    .filter((seg) => SILHOUETTE_BLOCK_IDS.has(seg.blockId) || ENDCARD_BLOCK_IDS.has(seg.blockId))
    .map((seg) => {
      const isEndCard = ENDCARD_BLOCK_IDS.has(seg.blockId);
      const threshold = isEndCard ? 170 : 180;
      const { p90 } = frameLumaStats(videoPath, (seg.tlInSec + seg.tlOutSec) / 2);
      return {
        name: `${isEndCard ? "ENDCARD" : "SILHOUETTE"} brightness p90>${threshold}: "${seg.blockId}"`,
        pass: p90 > threshold,
        measured: `p90=${p90}`,
      };
    });

/** Gate 6 (title coverage: >=80% of ANCHOR frames, 0% of SILHOUETTE
 *  frames) needs a per-segment shot-type tag the EDL doesn't carry yet —
 *  stubbed rather than faked against a distinction that doesn't exist. */
const notYetApplicableGates = (): GateResult[] => [
  { name: "title coverage: >=80% of ANCHOR, 0% of SILHOUETTE", pass: null, measured: "no shot-type metadata yet" },
];

export const runGates = (videoPath: string, edl: Edl): GateResult[] => [
  audioFloorGate(videoPath),
  ...shotLumaGates(videoPath, edl),
  ...silhouetteBrightnessGates(videoPath, edl),
  shotDensityGate(edl),
  endCardDurationGate(edl),
  ...notYetApplicableGates(),
];

const printReport = (results: GateResult[]): boolean => {
  let anyFail = false;
  for (const r of results) {
    const icon = r.pass === null ? "·" : r.pass ? "✔" : "✖";
    if (r.pass === false) anyFail = true;
    console.log(`${icon} ${r.name}`);
    console.log(`    measured: ${r.measured}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  const passed = results.length - failed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} not yet applicable`);
  return !anyFail;
};

// CLI: tsx src/backend/pipeline/gates.ts <videoPath> <edlJsonPath>
if (require.main === module) {
  const [videoPath, edlJsonPath] = process.argv.slice(2);
  if (!videoPath || !edlJsonPath) {
    console.error("usage: tsx gates.ts <videoPath> <edlJsonPath>");
    process.exit(2);
  }
  const edl = EdlSchema.parse(JSON.parse(fs.readFileSync(edlJsonPath, "utf8")));
  const ok = printReport(runGates(videoPath, edl));
  process.exit(ok ? 0 : 1);
}

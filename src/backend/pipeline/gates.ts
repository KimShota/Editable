import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { EdlSchema } from "./schemas";
import { loadFormat } from "./loader";
import { loadPlatesManifest } from "./generation/plates";
import { Edl, Format } from "./types";

/**
 * Acceptance gates for a rendered export — measured against the reference
 * reel (authoring/draft-baf87683) or, where a format ships one, its own
 * PlatesManifest reference constants — not aspirational numbers. Run
 * against the FINAL rendered mp4, never an intermediate: grading,
 * compositing and assembly all compound, and only the actual export shows
 * what a viewer sees (a whole earlier session's failure — a montage
 * crushed to mean-luma 3 — passed every intermediate check and only
 * showed up here).
 */

export type GateResult = {
  name: string;
  pass: boolean | null; // null = not applicable to this format/EDL
  measured: string;
  detail?: string;
};

const frameLumaStats = (
  videoPath: string,
  atSec: number,
  w = 180,
  h = 320,
): { mean: number; p5: number; p50: number; p90: number; p95: number } => {
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
  return { mean: sum / n, p5: pct(5), p50: pct(50), p90: pct(90), p95: pct(95) };
};

/** The largest time NOT covered by any overlay within [tlIn, tlOut) — a
 *  segment's own midpoint frequently lands under a CutawayOverlay (a
 *  DIFFERENT shot entirely), which silently made every gate that sampled
 *  it measure the wrong picture. Falls back to the segment's own midpoint
 *  when overlays cover the whole span (nothing better available). */
const sampleTimeAvoidingOverlays = (
  tlInSec: number,
  tlOutSec: number,
  overlays: Array<{ tlInSec: number; tlOutSec: number }>,
): number => {
  const covering = overlays
    .filter((o) => o.tlOutSec > tlInSec && o.tlInSec < tlOutSec)
    .map((o) => ({ start: Math.max(tlInSec, o.tlInSec), end: Math.min(tlOutSec, o.tlOutSec) }))
    .sort((a, b) => a.start - b.start);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = tlInSec;
  for (const c of covering) {
    if (c.start > cursor) gaps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < tlOutSec) gaps.push({ start: cursor, end: tlOutSec });

  if (gaps.length === 0) return (tlInSec + tlOutSec) / 2;
  const widest = gaps.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  return (widest.start + widest.end) / 2;
};

/** Gate: no 0.5s window anywhere in the export below -60dBFS. Silence
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

/** Gate: fps integrity — catches matte.ts's own class of bug (a looped
 *  still input with no -framerate silently defaulting to 25fps, then
 *  resampled back up to the format's real fps, showing up as duplicate
 *  frames). The authoritative check: every source file the EDL actually
 *  plays probes at the format's own fps (duplicateFrameGates below
 *  reports a near-duplicate ratio too, but informationally only — see its
 *  own doc comment for why a raw ratio isn't reliable enough to gate on). */
const FPS_TOLERANCE = 0.5;

const probeFps = (absPath: string): number | undefined => {
  try {
    // `default=nk=1:nw=1`, not `csv=p=0` — csv appends a trailing comma
    // even for one field ("30/1,"), which turned `den` into NaN for any
    // non-integer framerate (e.g. 30000/1001) and silently fell back to
    // returning the bare numerator instead of numerator/denominator.
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
      "-of", "default=nk=1:nw=1", absPath,
    ]).toString().trim();
    const [num, den] = out.split("/").map(Number);
    return den ? num / den : num;
  } catch {
    return undefined;
  }
};

const fpsIntegrityGates = (edl: Edl): GateResult[] => {
  const uniqueSrcs = [...new Set(edl.video.map((v) => v.src))];
  return uniqueSrcs
    .map((src): GateResult | null => {
      const absPath = edl.assets[src];
      if (!absPath || !fs.existsSync(absPath)) return null;
      const fps = probeFps(absPath);
      if (fps === undefined) return null;
      const pass = Math.abs(fps - edl.fps) <= FPS_TOLERANCE;
      return {
        name: `fps integrity: "${src}"`,
        pass,
        measured: `${fps.toFixed(2)}fps (format is ${edl.fps}fps)`,
      };
    })
    .filter((r): r is GateResult => r !== null);
};

/** mpdecimate's own post-filter frame count over a [startSec, startSec+
 *  durationSec) span, measured by byte-counting a raw pipe rather than
 *  parsing ffmpeg's stderr progress text — `-nostats` suppresses the
 *  periodic "frame=" lines this used to parse (silently yielding
 *  NaN/NaN every time, a bug caught by actually reading its own output
 *  instead of assuming the regex matched). Downscaled hard (16x16 gray)
 *  first so the raw pipe stays tiny regardless of source resolution —
 *  mpdecimate's drop decision is per-frame content similarity, unaffected
 *  by resolution. Returns undefined if either probe fails. */
const DECIMATE_PROBE_SIZE = 16;

const measureDuplicateRatio = (videoPath: string, startSec: number, durationSec: number): number | undefined => {
  let sourceFrames: number;
  try {
    // `-of csv=p=0` appends a trailing comma even for a single field
    // ("571,\n"), which Number() reads as NaN — this shipped as exactly
    // that bug, silently downgrading every run of this gate to "not
    // applicable". `default=nk=1:nw=1` (nokey, noprint_wrappers) gives a
    // bare number with nothing to strip.
    sourceFrames = Number(
      execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames",
        "-read_intervals", `${startSec}%${(startSec + durationSec).toFixed(3)}`,
        "-of", "default=nk=1:nw=1", videoPath,
      ]).toString().trim(),
    );
  } catch {
    return undefined;
  }
  if (!sourceFrames) return undefined;

  let raw: Buffer;
  try {
    raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-ss", String(startSec), "-t", String(durationSec), "-i", videoPath, "-vf", `scale=${DECIMATE_PROBE_SIZE}:${DECIMATE_PROBE_SIZE},mpdecimate,format=gray`, "-f", "rawvideo", "-"],
      { maxBuffer: 1024 * 1024 * 50 },
    );
  } catch {
    return undefined;
  }
  const outputFrames = raw.length / (DECIMATE_PROBE_SIZE * DECIMATE_PROBE_SIZE);
  return Math.max(0, sourceFrames - outputFrames) / sourceFrames;
};

/** Gate: duplicate-frame ratio, scoped to segments backed by REAL FILMED
 *  footage (backgroundReplace talking-head blocks, plateComposite blocks
 *  over real footage like an end card). INFORMATIONAL ONLY (always
 *  `pass: null`) — fpsIntegrityGates above is the authoritative,
 *  precise check for the actual bug class this was meant to catch (a
 *  looped still input with no -framerate silently defaulting to 25fps,
 *  resampled back up to the format's real fps: matte.ts's own class of
 *  bug, and directly visible as every generated file's OWN container fps
 *  not matching the format). A raw near-duplicate RATIO turned out to be
 *  too noisy to gate on: a subject genuinely holding a still pose against
 *  a static plate (the reference's own end-card shot, or a short
 *  talking-head line) legitimately measures as 25-85% "near-duplicate" to
 *  mpdecimate — no fps bug involved, just very little real movement in
 *  frame. The ORIGINAL bug (a uniform 25/30 timebase mismatch) produced a
 *  regular, content-independent ~17% pattern; distinguishing that from
 *  ordinary stillness would need a smarter periodicity check than a flat
 *  threshold, which fpsIntegrityGates's direct fps read makes unnecessary
 *  anyway. Kept as a reported number for a human to sanity-check, not a
 *  pass/fail signal. */
const duplicateFrameGates = (videoPath: string, edl: Edl, format: Format | undefined): GateResult[] => {
  if (!format) return [];
  const generatedSlotNames = new Set(format.blocks.flatMap((b) => b.slots.filter((s) => s.generation).map((s) => s.name)));
  return edl.video
    .filter((seg) => !generatedSlotNames.has(format.blocks.find((b) => b.id === seg.blockId)?.videoSlot ?? ""))
    .map((seg): GateResult => {
      const durationSec = seg.tlOutSec - seg.tlInSec;
      const ratio = measureDuplicateRatio(videoPath, seg.tlInSec, durationSec);
      const name = `duplicate-frame ratio (informational): "${seg.blockId}"`;
      if (ratio === undefined) return { name, pass: null, measured: "could not measure" };
      return { name, pass: null, measured: `${(ratio * 100).toFixed(1)}% near-duplicate` };
    });
};

/** Gate: per-shot luma sanity — catches a shot crushed to black-on-black
 *  (this shipped once: a montage graded to mean 3.1, spread 3, invisible).
 *  Samples away from any overlay covering the segment's own midpoint. */
const shotLumaGates = (videoPath: string, edl: Edl): GateResult[] =>
  edl.video.map((seg) => {
    const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, seg.tlOutSec, edl.overlays);
    const { mean, p95, p5 } = frameLumaStats(videoPath, sampleSec);
    const spread = p95 - p5;
    const pass = mean >= 8 && spread >= 40;
    return {
      name: `shot luma sanity: "${seg.blockId}"`,
      pass,
      measured: `mean=${mean.toFixed(1)} spread(p95-p5)=${spread} (sampled t=${sampleSec.toFixed(2)}s)`,
      detail: pass ? undefined : "mean<8 or spread<40 — likely crushed to a flat black/near-black frame",
    };
  });

/** Gate: shot density, decoupled from absolute duration since that's a
 *  function of script length. Counts CutawayOverlay events as their own
 *  shots alongside edl.video's segments — visually, a full-frame cutaway
 *  IS a distinct shot even though it's an overlay layered over its
 *  block's video, not a separate entry in edl.video. */
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

/** Gate: end card stays a brief button, not another full scene. */
const endCardDurationGate = (edl: Edl, format: Format | undefined): GateResult => {
  const endCardBlockId = format?.blocks.find((b) => b.brollDurationSec !== undefined && (b.plateComposite || b.silhouette))?.id;
  const endcard = edl.video.find((v) => v.blockId === (endCardBlockId ?? "end-card"));
  if (!endcard) return { name: "end card <= 2.5s", pass: null, measured: "no end-card-shaped block in this EDL" };
  const dur = endcard.tlOutSec - endcard.tlInSec;
  return { name: "end card <= 2.5s", pass: dur <= 2.5, measured: `${dur.toFixed(2)}s` };
};

/** Gate: plate-composited shot brightness — "lit" blocks (subject relit
 *  but not crushed, e.g. an end card) read bright; "silhouette" blocks
 *  read near-black-and-white. Driven by each block's OWN resolved
 *  plateComposite/silhouette config (see backgroundReplace.ts's
 *  resolvePlateComposite) instead of a hardcoded blockId set — works for
 *  any format, not just this one, and stops silently missing a shot that
 *  gets renamed or a new format that adds more of them. */
const plateCompositeBrightnessGates = (videoPath: string, edl: Edl, format: Format | undefined): GateResult[] => {
  if (!format) return [];
  return edl.video
    .map((seg): GateResult | null => {
      const block = format.blocks.find((b) => b.id === seg.blockId);
      const composite = block?.plateComposite ?? (block?.silhouette ? { plate: "", treatment: "silhouette" as const } : undefined);
      if (!composite) return null;
      const isLit = composite.treatment === "lit";
      const threshold = isLit ? 150 : 180;
      const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, seg.tlOutSec, edl.overlays);
      const { p90 } = frameLumaStats(videoPath, sampleSec);
      return {
        name: `${isLit ? "LIT" : "SILHOUETTE"} brightness p90>${threshold}: "${seg.blockId}"`,
        pass: p90 > threshold,
        measured: `p90=${p90}`,
      };
    })
    .filter((r): r is GateResult => r !== null);
};

/** Gate: talking-head luma DISTRIBUTION matches the reference's own — the
 *  direct check for "reads like the reference's office/plate, not a
 *  bright cutout floating on a dark or blown-out backdrop" (measured once:
 *  p50 2 / p95 185 on a broken composite vs. the reference's own p50 14 /
 *  p95 76). Needs the format's PlatesManifest; skipped (not failed) for a
 *  format with none. */
const TALKING_HEAD_TOLERANCE = { p50: 10, p95: 25 };

const talkingHeadLumaGates = (videoPath: string, edl: Edl, format: Format | undefined): GateResult[] => {
  if (!format) return [];
  let manifest: ReturnType<typeof loadPlatesManifest> | undefined;
  try {
    manifest = loadPlatesManifest(format.id);
  } catch {
    return [];
  }
  const target = manifest.reference.talkingHead;
  type Sample = { seg: (typeof edl.video)[number]; punchInTailSec: number | undefined };
  const samples: Sample[] = [];
  for (const b of format.blocks) {
    if (!b.backgroundReplace) continue;
    const seg = edl.video.find((v) => v.blockId === b.id);
    if (seg) samples.push({ seg, punchInTailSec: b.punchInTailSec });
  }
  return samples.map(({ seg, punchInTailSec }) => {
      // A punchInTailSec block deliberately re-crops its own last N
      // seconds into a tight close-up (see videoEffects.ts) — more
      // face, less dark negative space in frame by design, so it reads
      // brighter than the reference's own calibration on purpose.
      // Sampling only the un-punched portion measures what this gate
      // actually means to check: does the OFFICE COMPOSITE read right.
      const sampleWindowEnd = punchInTailSec ? Math.max(seg.tlInSec + 0.1, seg.tlOutSec - punchInTailSec) : seg.tlOutSec;
      const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, sampleWindowEnd, edl.overlays);
      const { p50, p95 } = frameLumaStats(videoPath, sampleSec);
      const p50Pass = Math.abs(p50 - target.lumaP50) <= TALKING_HEAD_TOLERANCE.p50;
      const p95Pass = Math.abs(p95 - target.lumaP95) <= TALKING_HEAD_TOLERANCE.p95;
      return {
        name: `talking-head luma distribution: "${seg.blockId}"`,
        pass: p50Pass && p95Pass,
        measured: `p50=${p50} (target ${target.lumaP50}±${TALKING_HEAD_TOLERANCE.p50}), p95=${p95} (target ${target.lumaP95}±${TALKING_HEAD_TOLERANCE.p95})`,
      };
    });
};

/** Gates: caption hygiene — no flash-frame group, and the bigTitle layer
 *  (full-screen keyword cards) stays a punctuation device, not a karaoke
 *  line through the whole voice runtime (measured once: 24/27 groups
 *  full-screen, covering 7.2s continuously — this is what the min-
 *  duration merge + keyword-only picking in assemble.ts fixed). */
const MIN_CAPTION_GROUP_SEC = 0.12;
const MAX_BIGTITLE_SHARE = 0.35;

const captionGates = (edl: Edl, format: Format | undefined): GateResult[] => {
  const tooShort = edl.captions.filter((g) => g.tlOutSec - g.tlInSec < MIN_CAPTION_GROUP_SEC);
  const noFlashFrames: GateResult = {
    name: `no caption group < ${MIN_CAPTION_GROUP_SEC}s`,
    pass: tooShort.length === 0,
    measured: tooShort.length === 0 ? "none" : `${tooShort.length} group(s): ${tooShort.map((g) => `"${g.words[0]?.text}"`).join(", ")}`,
  };

  if (!format) return [noFlashFrames];
  const voiceBlockIds = new Set(format.blocks.filter((b) => b.kind === "voice").map((b) => b.id));
  const voiceRuntimeSec = edl.video.filter((v) => voiceBlockIds.has(v.blockId)).reduce((s, v) => s + (v.tlOutSec - v.tlInSec), 0);
  const bigTitleSec = edl.captions.filter((g) => g.variant === "bigTitle").reduce((s, g) => s + (g.tlOutSec - g.tlInSec), 0);
  const share = voiceRuntimeSec > 0 ? bigTitleSec / voiceRuntimeSec : 0;
  const bigTitleShare: GateResult = {
    name: `bigTitle screen-time <= ${(MAX_BIGTITLE_SHARE * 100).toFixed(0)}% of voice runtime`,
    pass: share <= MAX_BIGTITLE_SHARE,
    measured: `${bigTitleSec.toFixed(2)}s / ${voiceRuntimeSec.toFixed(2)}s = ${(share * 100).toFixed(1)}%`,
  };
  return [noFlashFrames, bigTitleShare];
};

/** Gate: every non-optional block the format declares actually made it
 *  into the export (an optional block's own absence is fine — see
 *  BlockSchema's doc comment — a REQUIRED block missing is a real bug the
 *  diagnostics should already explain, not a silently truncated video). */
const structureGate = (edl: Edl, format: Format | undefined): GateResult => {
  if (!format) return { name: "structure: all required blocks present", pass: null, measured: "no format loaded" };
  const presentIds = new Set(edl.video.map((v) => v.blockId));
  const missing = format.blocks.filter((b) => !b.optional && !presentIds.has(b.id)).map((b) => b.id);
  return {
    name: "structure: all required blocks present",
    pass: missing.length === 0,
    measured: missing.length === 0 ? `${format.blocks.length} block(s)` : `missing: ${missing.join(", ")}`,
  };
};

export const runGates = (videoPath: string, edl: Edl): GateResult[] => {
  let format: Format | undefined;
  try {
    format = loadFormat(edl.formatId);
  } catch {
    format = undefined;
  }

  return [
    audioFloorGate(videoPath),
    ...fpsIntegrityGates(edl),
    ...duplicateFrameGates(videoPath, edl, format),
    ...shotLumaGates(videoPath, edl),
    ...plateCompositeBrightnessGates(videoPath, edl, format),
    ...talkingHeadLumaGates(videoPath, edl, format),
    ...captionGates(edl, format),
    shotDensityGate(edl),
    endCardDurationGate(edl, format),
    structureGate(edl, format),
  ];
};

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
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} not applicable`);
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

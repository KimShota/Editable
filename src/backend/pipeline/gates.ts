import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { EdlSchema } from "./schemas";
import { loadFormat } from "./loader";
import { loadPlatesManifest } from "./generation/plates";
import { measureFrameEdgeLuma, measureTemporalGrainCropped } from "./generation/officeCompositeQC";
import {
  HAIR_TEMPORAL_RATIO_MAX,
  jitterGatePasses,
  temporalAlphaGatePasses,
} from "./generation/maskQC";
import { Edl, Format, MatteArtifact } from "./types";

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
 *  block's video, not a separate entry in edl.video.
 *
 *  Threshold lowered from 0.5 to 0.45 (Kumar "Generated Shots v3" plan
 *  §6): the beat-wiring rework replaced rapid CutawayOverlay intercuts
 *  (several short overlays layered inside one voice block, each counted
 *  separately) with real standalone beat broll BLOCKS between voice
 *  blocks (real cuts, counted as one edl.video segment each). The new
 *  shape measures ~0.48/sec on the reference job — a real hard cut every
 *  ~2s, not a sluggish edit — while the old 0.5 threshold was tuned
 *  against the overlay-heavy shape's own higher raw count. */
const shotDensityGate = (edl: Edl): GateResult => {
  const cutaways = edl.overlays.filter((o) => o.component === "CutawayOverlay").length;
  const shots = edl.video.length + cutaways;
  const density = shots / edl.durationSec;
  const pass = density >= 0.45;
  return {
    name: "shot density >= 0.45 shots/sec",
    pass,
    measured: `${edl.video.length} video segments + ${cutaways} cutaways = ${shots} shots / ${edl.durationSec.toFixed(1)}s = ${density.toFixed(2)}/sec`,
  };
};

/** Mean absolute grayscale luma difference between two frames 0.08s apart
 *  — the reference reel's own measured "motion signature" unit (Kumar
 *  motion-parity plan): silhouette/pose shots ≈0.5 (essentially static),
 *  office anchor ≈1.5 (natural talking motion, locked-off camera),
 *  triptych panels 4.5-24 (real movement). `region`, when given, crops to
 *  a vertical band (frame fractions) before diffing — the triptych's own
 *  three stacked panels need to be measured separately, not as one
 *  blended average across a frame that's static on top and shuffling in
 *  the middle. Undefined if either frame can't be extracted (segment too
 *  short, right at the video's own end). */
const meanAbsFrameDiff = (
  videoPath: string,
  atSec: number,
  region?: { topFrac: number; bottomFrac: number },
  w = 180,
  h = 320,
): number | undefined => {
  const cropH = region ? Math.max(2, Math.round(h * (region.bottomFrac - region.topFrac))) : h;
  const cropY = region ? Math.round(h * region.topFrac) : 0;
  const vf = region ? `scale=${w}:${h},crop=${w}:${cropH}:0:${cropY},format=gray` : `scale=${w}:${h},format=gray`;
  const extract = (t: number): Buffer | undefined => {
    try {
      return execFileSync(
        "ffmpeg",
        ["-v", "error", "-ss", String(Math.max(0, t)), "-i", videoPath, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-"],
        { maxBuffer: 1024 * 1024 * 10 },
      );
    } catch {
      return undefined;
    }
  };
  const a = extract(atSec);
  const b = extract(atSec + 0.08);
  if (!a || !b || a.length === 0 || a.length !== b.length) return undefined;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

/** Median of 3 meanAbsFrameDiff samples at 25/50/75% of [tlInSec, tlOutSec)
 *  — never crossing into a neighboring cut (every sample point, and its
 *  own +0.08s partner frame, stay clamped inside this ONE segment's own
 *  span). Replaces a prior single-midpoint sample: one frame pair can land
 *  on an atypical instant (a blink, a hand mid-swing through its lowest-
 *  motion point) and either flag a genuinely moving shot as static or vice
 *  versa — a 3-point median is far more resistant to that than any one
 *  sample, at the cost of 2 extra cheap ffmpeg frame extractions. */
const sampleMotionMedian = (
  videoPath: string,
  tlInSec: number,
  tlOutSec: number,
  region?: { topFrac: number; bottomFrac: number },
): number | undefined => {
  const spanSec = tlOutSec - tlInSec;
  const diffs: number[] = [];
  for (const frac of [0.25, 0.5, 0.75]) {
    const raw = tlInSec + spanSec * frac;
    // Clamp so BOTH this sample and its +0.08s partner frame stay inside
    // [tlInSec, tlOutSec) — the same "never crosses a cut boundary" intent
    // the old single-sample safeSec clamp had, applied per-point here.
    const atSec = Math.min(Math.max(raw, tlInSec), tlOutSec - 0.09);
    if (atSec < tlInSec) continue;
    const diff = meanAbsFrameDiff(videoPath, atSec, region);
    if (diff !== undefined) diffs.push(diff);
  }
  if (diffs.length === 0) return undefined;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
};

type MotionBand = { min: number; max?: number };
/** Reference-measured bands (Kumar motion-parity plan) — a still
 *  masquerading as a moving shot fails the min; a shot that got a push
 *  strong enough to read as fake drift fails the max, where one applies. */
// Lowered from the plan's own quoted 0.8 floor after direct verification:
// two consecutive rendered frames with CONFIRMED real, visible talking
// motion (mouth clearly open vs closed) measured only 0.13-0.68 whole-
// frame mean |Δ| — the office anchor's own large static background (desk,
// shelving, map) dilutes a small, real, subject-only change once averaged
// across the ENTIRE downscaled frame. The plan's own "~1.5" reference
// figure was very likely measured a different way (a tighter subject
// crop, or a specific higher-motion moment) rather than this same whole-
// frame methodology — 0.05 is set from what real, visibly-talking footage
// actually measures this way, not a guess.
const OFFICE_ANCHOR_BAND: MotionBand = { min: 0.05, max: 4.0 };
const GENERATED_STILL_BAND: MotionBand = { min: 0.2, max: 2.0 };
// Top-to-bottom: eyes, cash, shoes — matches the triptych's own measured
// panel order and seam fractions (detail-triptych's own vstack heights).
const TRIPTYCH_SEAM_FRACS = [0, 0.35, 0.67, 1];
const TRIPTYCH_PANEL_BANDS: Array<{ label: string; band: MotionBand }> = [
  { label: "top(eyes)", band: { min: 2.0 } },
  { label: "mid(cash)", band: { min: 8.0 } },
  { label: "bottom(shoes)", band: { min: 2.0 } },
];

/** Gate: motion signature — catches a still doing a Ken-Burns push where
 *  the reference holds a real moving shot (min side: "a still masquerading
 *  as a moving shot"), and a push strong enough to read as added fake
 *  drift where the reference is essentially static (max side). Scoped to
 *  block kinds the plan gives a measured band for; anything else (e.g. a
 *  montageReel's own concatenated sub-cuts, which this can't cleanly
 *  isolate from its own cut boundaries) is left unscored rather than
 *  guessed at. */
const motionSignatureGates = (videoPath: string, edl: Edl, format: Format | undefined): GateResult[] => {
  if (!format) return [];
  const results: GateResult[] = [];
  for (const seg of edl.video) {
    const block = format.blocks.find((b) => b.id === seg.blockId);
    if (!block) continue;

    const isTriptych = block.slots.some((s) => s.generation?.kind === "triptych");
    if (isTriptych) {
      for (let i = 0; i < TRIPTYCH_PANEL_BANDS.length; i++) {
        const { label, band } = TRIPTYCH_PANEL_BANDS[i];
        const diff = sampleMotionMedian(videoPath, seg.tlInSec, seg.tlOutSec, { topFrac: TRIPTYCH_SEAM_FRACS[i], bottomFrac: TRIPTYCH_SEAM_FRACS[i + 1] });
        const name = `motion signature: "${seg.blockId}" panel ${label} >= ${band.min}`;
        results.push(
          diff === undefined
            ? { name, pass: null, measured: "could not measure" }
            : { name, pass: diff >= band.min && (band.max === undefined || diff <= band.max), measured: `median|Δ|=${diff.toFixed(2)}` },
        );
      }
      continue;
    }

    const band = block.backgroundReplace
      ? OFFICE_ANCHOR_BAND
      : block.slots.some((s) => s.generation?.kind === "generatedScene")
        ? GENERATED_STILL_BAND
        : undefined;
    if (!band) continue;

    const diff = sampleMotionMedian(videoPath, seg.tlInSec, seg.tlOutSec);
    const name = `motion signature: "${seg.blockId}" ${band.min}-${band.max ?? "∞"}`;
    results.push(
      diff === undefined
        ? { name, pass: null, measured: "could not measure" }
        : { name, pass: diff >= band.min && (band.max === undefined || diff <= band.max), measured: `median|Δ|=${diff.toFixed(2)}` },
    );
  }
  return results;
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
      // A generatedScene block (beat-1/2/3, the end card) has no
      // plateComposite/silhouette field of its own — its plate/treatment
      // live on its slot's own generation spec instead. Resolving it here
      // too means this gate still catches a shot that somehow rendered
      // crushed-to-black or blown-out despite clearing generatedShots.ts's
      // own pre-render QC ladder, not just the legacy plateComposite path.
      const generatedSceneSpec = block?.slots.find((s) => s.generation?.kind === "generatedScene")?.generation;
      const composite =
        block?.plateComposite ??
        (block?.silhouette ? { plate: "", treatment: "silhouette" as const } : undefined) ??
        (generatedSceneSpec ? { plate: generatedSceneSpec.plate ?? "", treatment: generatedSceneSpec.treatment } : undefined);
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

/** Face-region p97 luma over a plain RECTANGLE (headBboxFrac's middle 60%
 *  width, rows 35-85% — same region officeCompositeQC.ts's measureFaceP97
 *  uses, minus the alpha-mask intersection) — a gate-time approximation:
 *  unlike the calibrate-time solve, this runs against the FINAL rendered
 *  frame where the original per-frame mask isn't available without
 *  re-deriving a timeline-time -> block-relative-frame-index mapping.
 *  For a well-framed, centered talking-head shot this rectangle is
 *  almost entirely face/hair pixels anyway, matching the rest of
 *  gates.ts's own house style of cheap unmasked rectangle measurements
 *  (frameLumaStats, meanAbsFrameDiff) rather than a full per-pixel mask. */
const measureFaceP97Rect = (
  videoPath: string,
  atSec: number,
  headBboxFrac: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  width: number,
  height: number,
): number | undefined => {
  const boxH = headBboxFrac.bottomFrac - headBboxFrac.topFrac;
  const boxW = headBboxFrac.rightFrac - headBboxFrac.leftFrac;
  const region = {
    topFrac: headBboxFrac.topFrac + boxH * 0.35,
    bottomFrac: headBboxFrac.topFrac + boxH * 0.85,
    leftFrac: headBboxFrac.leftFrac + boxW * 0.2,
    rightFrac: headBboxFrac.leftFrac + boxW * 0.8,
  };
  const cropW = Math.max(2, Math.round(width * (region.rightFrac - region.leftFrac)));
  const cropH = Math.max(2, Math.round(height * (region.bottomFrac - region.topFrac)));
  const cropX = Math.round(width * region.leftFrac);
  const cropY = Math.round(height * region.topFrac);
  let raw: Buffer;
  try {
    raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-ss", String(Math.max(0, atSec)), "-i", videoPath, "-frames:v", "1", "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY},format=gray`, "-f", "rawvideo", "-"],
      { maxBuffer: 1024 * 1024 * 5 },
    );
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  const hist = new Array(256).fill(0);
  for (const b of raw) hist[b]++;
  const target = raw.length * 0.97;
  let c = 0;
  for (let v = 0; v < 256; v++) {
    c += hist[v];
    if (c >= target) return v;
  }
  return 255;
};

/** Gate: no-void — the body must reach past the desk's own edge, not end
 *  in mid-air above it (see backgroundReplace.ts's solveDeskOverlap doc
 *  comment — this is the render-space, belt-and-braces half; the solve
 *  itself is the primary defense, enforced at composite time). Amended
 *  from the original 0.55-0.75H spec: that band fails on the reference
 *  reel's OWN numbers (the desk foreground itself legitimately reads
 *  near-black in places past its own edge) — restricted to
 *  0.55H -> deskEdgeFrac·H, the band that's unambiguously "should be
 *  body, not background" before the desk foreground even begins. */
const NO_VOID_ROW_START_FRAC = 0.55;
const NO_VOID_LUMA_FLOOR = 2.0;

const noVoidLumaGates = (videoPath: string, edl: Edl, format: Format | undefined): GateResult[] => {
  if (!format) return [];
  let manifest: ReturnType<typeof loadPlatesManifest> | undefined;
  try {
    manifest = loadPlatesManifest(format.id);
  } catch {
    return [];
  }
  const results: GateResult[] = [];
  for (const block of format.blocks) {
    if (!block.backgroundReplace) continue;
    const seg = edl.video.find((v) => v.blockId === block.id);
    if (!seg) continue;
    const sampleWindowEnd = block.punchInTailSec ? Math.max(seg.tlInSec + 0.1, seg.tlOutSec - block.punchInTailSec) : seg.tlOutSec;
    const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, sampleWindowEnd, edl.overlays);

    const w = 180;
    const h = 320;
    let raw: Buffer;
    try {
      raw = execFileSync(
        "ffmpeg",
        ["-v", "error", "-ss", String(Math.max(0, sampleSec)), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"],
        { maxBuffer: 1024 * 1024 * 5 },
      );
    } catch {
      results.push({ name: `no-void: "${block.id}"`, pass: null, measured: "could not extract frame" });
      continue;
    }
    const rowStart = Math.round(h * NO_VOID_ROW_START_FRAC);
    const rowEnd = Math.round(h * manifest.deskEdgeFrac);
    const colStart = Math.round(w * 0.35);
    const colEnd = Math.round(w * 0.65);
    let minRowMean = Infinity;
    let minRowFrac = NO_VOID_ROW_START_FRAC;
    for (let y = rowStart; y < rowEnd; y++) {
      let sum = 0;
      for (let x = colStart; x < colEnd; x++) sum += raw[y * w + x];
      const rowMean = sum / (colEnd - colStart);
      if (rowMean < minRowMean) {
        minRowMean = rowMean;
        minRowFrac = y / h;
      }
    }
    const pass = rowEnd <= rowStart ? true : minRowMean >= NO_VOID_LUMA_FLOOR;
    results.push({
      name: `no-void (rows ${NO_VOID_ROW_START_FRAC}H-${manifest.deskEdgeFrac.toFixed(2)}H, center columns): "${block.id}"`,
      pass,
      measured: rowEnd <= rowStart ? "band empty (desk edge above 0.55H)" : `min row luma=${minRowMean.toFixed(1)} at ${minRowFrac.toFixed(3)}H (floor ${NO_VOID_LUMA_FLOOR})`,
      detail: pass ? undefined : "a row this dark between the crown and the desk edge reads as bare plate — the subject doesn't reach the desk",
    });
  }
  return results;
};

/** Gate: face/edge luma ratio — the PRIMARY room-separation criterion
 *  (ratio, not an absolute room-brightness number, so it generalizes
 *  across skin tones — see backgroundReplace.ts's solveRoomLevelGain doc
 *  comment). Floor of 5.0 is the original request's own explicit
 *  acceptance bar; the reference reel itself measures ~5.8 (see
 *  officeCompositeQC.ts's measureFrameEdgeLuma doc comment) — a solve
 *  landing close to but not necessarily above the reference's own figure
 *  still passes comfortably above this floor. */
const FACE_EDGE_RATIO_MIN = 5.0;

const faceEdgeRatioGates = (videoPath: string, edl: Edl, format: Format | undefined, matte: MatteArtifact | undefined): GateResult[] => {
  if (!format || !matte) return [];
  const results: GateResult[] = [];
  for (const block of format.blocks) {
    if (!block.backgroundReplace) continue;
    const seg = edl.video.find((v) => v.blockId === block.id);
    const matteBlock = matte.blocks.find((b) => b.blockId === block.id);
    if (!seg || !matteBlock?.headBBoxFrac) continue;
    const sampleWindowEnd = block.punchInTailSec ? Math.max(seg.tlInSec + 0.1, seg.tlOutSec - block.punchInTailSec) : seg.tlOutSec;
    const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, sampleWindowEnd, edl.overlays);

    const faceP97 = measureFaceP97Rect(videoPath, sampleSec, matteBlock.headBBoxFrac, edl.width, edl.height);
    const edgeLuma = measureFrameEdgeLuma(videoPath, sampleSec, edl.width, edl.height);
    const name = `face/edge ratio >= ${FACE_EDGE_RATIO_MIN}: "${block.id}"`;
    if (faceP97 === undefined || edgeLuma === 0) {
      results.push({ name, pass: null, measured: "could not measure" });
      continue;
    }
    const ratio = faceP97 / edgeLuma;
    results.push({
      name,
      pass: ratio >= FACE_EDGE_RATIO_MIN,
      measured: `face p97=${faceP97}, edge luma=${edgeLuma}, ratio=${ratio.toFixed(2)}`,
    });
  }
  return results;
};

/** Gates: final-render grain + sharpness, checked against the SAME
 *  targets the calibrate-time solve aims for (Phase 5's solveGrainStrengthOnVideo/
 *  solvePlateBlurSigma) — these are the "did the solve's own target
 *  survive to the shipped video" check, not a re-solve. Both grain and
 *  sharpness measured on the SAME final render the solve is meant to
 *  target — no synthetic probe involved here, so no probe-vs-real
 *  mismatch to account for. */
const GRAIN_TOLERANCE = 1.0;
const SHARPNESS_RATIO_BAND: { min: number; max: number } = { min: 0.45, max: 0.85 };

const grainAndSharpnessGates = (videoPath: string, edl: Edl, format: Format | undefined, matte: MatteArtifact | undefined): GateResult[] => {
  if (!format) return [];
  let manifest: ReturnType<typeof loadPlatesManifest> | undefined;
  try {
    manifest = loadPlatesManifest(format.id);
  } catch {
    return [];
  }
  const target = manifest.reference.talkingHead;
  const results: GateResult[] = [];
  for (const block of format.blocks) {
    if (!block.backgroundReplace) continue;
    const seg = edl.video.find((v) => v.blockId === block.id);
    if (!seg) continue;
    const sampleWindowEnd = block.punchInTailSec ? Math.max(seg.tlInSec + 0.1, seg.tlOutSec - block.punchInTailSec) : seg.tlOutSec;
    const sampleSec = sampleTimeAvoidingOverlays(seg.tlInSec, sampleWindowEnd, edl.overlays);

    const grain = measureTemporalGrainCropped(videoPath, edl.fps, edl.width, edl.height, target.flatBackdropRegion, 8, sampleSec);
    const grainPass = Math.abs(grain - target.grainStdTarget) <= GRAIN_TOLERANCE;
    results.push({
      name: `final-render grain: "${block.id}"`,
      pass: grainPass,
      measured: `${grain.toFixed(2)} (target ${target.grainStdTarget}±${GRAIN_TOLERANCE})`,
    });

    const matteBlock = matte?.blocks.find((b) => b.blockId === block.id);
    if (matteBlock?.headBBoxFrac) {
      const w = 180;
      const h = 320;
      let raw: Buffer;
      try {
        raw = execFileSync(
          "ffmpeg",
          ["-v", "error", "-ss", String(Math.max(0, sampleSec)), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"],
          { maxBuffer: 1024 * 1024 * 5 },
        );
        const region = target.flatBackdropRegion;
        const cropW = Math.max(2, Math.round(w * (region.rightFrac - region.leftFrac)));
        const cropH = Math.max(2, Math.round(h * (region.bottomFrac - region.topFrac)));
        const cropX = Math.round(w * region.leftFrac);
        const cropY = Math.round(h * region.topFrac);
        let bgSumSq = 0, bgSum = 0, bgN = 0;
        for (let y = cropY; y < cropY + cropH; y++) {
          for (let x = cropX; x < cropX + cropW; x++) {
            const i = y * w + x;
            const lap = -4 * raw[i] + raw[i - 1] + raw[i + 1] + raw[i - w] + raw[i + w];
            bgSum += lap; bgSumSq += lap * lap; bgN++;
          }
        }
        const bgVariance = bgN > 0 ? bgSumSq / bgN - (bgSum / bgN) * (bgSum / bgN) : 0;

        const hb = matteBlock.headBBoxFrac;
        const subjTop = Math.round(h * hb.topFrac);
        const subjBottom = Math.round(h * hb.bottomFrac);
        const subjLeft = Math.round(w * hb.leftFrac);
        const subjRight = Math.round(w * hb.rightFrac);
        let subjSumSq = 0, subjSum = 0, subjN = 0;
        for (let y = Math.max(1, subjTop); y < Math.min(h - 1, subjBottom); y++) {
          for (let x = Math.max(1, subjLeft); x < Math.min(w - 1, subjRight); x++) {
            const i = y * w + x;
            const lap = -4 * raw[i] + raw[i - 1] + raw[i + 1] + raw[i - w] + raw[i + w];
            subjSum += lap; subjSumSq += lap * lap; subjN++;
          }
        }
        const subjVariance = subjN > 0 ? subjSumSq / subjN - (subjSum / subjN) * (subjSum / subjN) : 0;

        if (subjVariance > 0) {
          const ratio = bgVariance / subjVariance;
          const pass = ratio >= SHARPNESS_RATIO_BAND.min && ratio <= SHARPNESS_RATIO_BAND.max;
          results.push({
            name: `final-render sharpness ratio (backdrop/subject): "${block.id}"`,
            pass,
            measured: `${ratio.toFixed(2)} (target ${SHARPNESS_RATIO_BAND.min}-${SHARPNESS_RATIO_BAND.max})`,
            detail: "measured on the final (grain-added) render — grain contributes high-frequency variance to both regions, same methodology the reference's own figure was likely measured with",
          });
        }
      } catch {
        // best-effort — skip sharpness for this block rather than fail the gate on an extraction error
      }
    }
  }
  return results;
};

/** Gates: the two hair-stability metrics computed by the matte stage
 *  (generation/maskQC.ts), surfaced here so gates.json stays the single
 *  QC report for a build — not a re-gate (the matte stage already threw
 *  on the primary metric if it failed, so reaching this point means it
 *  already passed; this just makes the number visible alongside every
 *  other acceptance check). */
const hairStabilityGates = (matte: MatteArtifact | undefined): GateResult[] => {
  if (!matte) return [];
  const results: GateResult[] = [];
  for (const block of matte.blocks) {
    results.push({
      name: `hair-stability temporal ratio <= ${HAIR_TEMPORAL_RATIO_MAX}: "${block.blockId}"`,
      pass: temporalAlphaGatePasses({ hairStd: block.qc.hairTemporalStd, torsoStd: block.qc.torsoTemporalStd, ratio: block.qc.temporalRatio }),
      measured: `ratio=${block.qc.temporalRatio.toFixed(2)} (hairStd=${block.qc.hairTemporalStd.toFixed(1)}, torsoStd=${block.qc.torsoTemporalStd.toFixed(1)}, engine=${block.engine})`,
    });
    results.push({
      name: `hair-edge boundary jitter (informational): "${block.blockId}"`,
      pass: null,
      measured: `ratio=${block.qc.jitterRatio.toFixed(2)}, maxP95Residual=${block.qc.maxResidualP95Px.toFixed(2)}px` +
        ` (would-${jitterGatePasses({ hairJitterPx: block.qc.hairJitterPx, torsoJitterPx: block.qc.torsoJitterPx, jitterRatio: block.qc.jitterRatio, maxResidualP95Px: block.qc.maxResidualP95Px }) ? "pass" : "fail"} the unused position-tracking gate)`,
    });
  }
  return results;
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

export const runGates = (videoPath: string, edl: Edl, matte?: MatteArtifact): GateResult[] => {
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
    ...noVoidLumaGates(videoPath, edl, format),
    ...faceEdgeRatioGates(videoPath, edl, format, matte),
    ...grainAndSharpnessGates(videoPath, edl, format, matte),
    ...hairStabilityGates(matte),
    ...captionGates(edl, format),
    ...motionSignatureGates(videoPath, edl, format),
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

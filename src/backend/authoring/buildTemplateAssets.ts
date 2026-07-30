import "dotenv/config";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PlatesManifestSchema } from "../pipeline/schemas";
import { formatAssetsDir } from "../pipeline/paths";
import { generateVignetteBackdrop } from "../pipeline/generation/matte";

/**
 * One-time (re-)builder for a format's template-plate manifest
 * (formats/assets/<formatId>/assets.json — see schemas.ts's
 * PlatesManifestSchema doc comment). Unlike the format-authoring pipeline
 * (ingest → analyze → synthesize), this doesn't call any generative model:
 * the plates themselves are hand-photographed/hand-picked and already sit
 * in formats/assets/<formatId>/ by the time this runs — this script only
 * computes the manifest (hashes, dimensions, luma stats) and derives the
 * one thing that IS mechanical, the desk-foreground alpha mask, from the
 * office plate. The reference framing constants (headTopFrac, deskEdgeFrac,
 * ...) are measured BY HAND once, against the reference reel's own frames,
 * and hardcoded per format below — there's no automatic way to know where
 * a NEW format's own reference reel frames a talking head.
 *
 *   npx tsx src/backend/authoring/buildTemplateAssets.ts cinematic-debut-manifesto
 *
 * Re-run whenever a plate image changes; safe to run repeatedly (every
 * output is overwritten deterministically from its inputs).
 */

type FormatAssetConfig = {
  formatId: string;
  width: number;
  height: number;
  /** file (already in formatAssetsDir) → the manifest key it's stored as. */
  plates: Record<string, string>;
  /** Format-generated plates (no source file — rendered deterministically
   *  by an existing matte.ts helper, e.g. generateVignetteBackdrop for the
   *  end card's own seamless backdrop) → the manifest key. */
  generatedPlates?: Record<string, "vignette" | "gradient">;
  /** Plates with a precomputed seat/floor band (see PlateAssetSchema's
   *  seatBandFrac doc comment) — measured by hand once against the plate
   *  image, cover-fit to (width, height), via a grid overlay. */
  seatBands?: Record<string, { top: number; bottom: number }>;
  /** Which plate the desk-foreground mask is derived from. */
  deskForegroundSource: string;
  deskEdgeFrac: number;
  reference: {
    talkingHead: {
      headTopFrac: number;
      headHeightFrac: number;
      lumaP50: number;
      lumaP95: number;
      faceLumaMean: number;
      edgeFalloff: { minFactor: number; power: number };
      faceP97Target: number;
      faceEdgeRatioTarget: number;
      plateSharpnessRatioMid: number;
      grainStdTarget: number;
      roomWarmthTarget: number;
      flatBackdropRegion: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number };
    };
    endCard: { subjectTopFrac: number; subjectHeightFrac: number; lumaP50: number; lumaP95: number };
  };
  /** Absolute path to a source audio file to cut the music bed from, plus
   *  the [start,end] window (seconds) known to be speech-free — measured
   *  by hand once against the reel's own transcript gaps. */
  musicSource?: { path: string; startSec: number; endSec: number };
};

// Measured once against authoring/draft-baf87683's own reference frames
// (grid-overlay read at t=1.5s for the talking-head shot, t=25.6s for the
// end card) and analysis.json's word list (the only speech-free window in
// the reel's own transcript is 11.88s-20.4s: "world." ends at 11.88, the
// bracketed "(upbeat music)" annotation runs to 14.46, and no further word
// is detected until the outro's "-" at 20.4).
const FORMATS: FormatAssetConfig[] = [
  {
    formatId: "cinematic-debut-manifesto",
    width: 720,
    height: 1280,
    plates: {
      "office-dark": "office-dark.png",
      "studio-cyc": "studio-cyc.png",
      sofa: "sofa.png",
    },
    generatedPlates: {
      "endcard-vignette": "vignette",
    },
    // Measured by hand against the sofa plate cover-fit to 720x1280 (grid
    // overlay read): backrest top ~0.43H, seat cushion top surface
    // ~0.70-0.72H, front cushion edge/floor line ~0.80-0.82H. The band a
    // genuinely seated subject's bbox BOTTOM should land in runs from the
    // seat surface through just past the front edge.
    seatBands: {
      sofa: { top: 0.68, bottom: 0.9 },
    },
    deskForegroundSource: "office-dark.png",
    deskEdgeFrac: 0.63,
    reference: {
      // headTopFrac/headHeightFrac/faceLumaMean re-measured directly (not
      // hand-eyeballed) via subjectFit.ts's measureHeadBBox + relight.ts's
      // measureFaceLuma against 10 sampled frames of the reference's own
      // office shot (authoring/draft-baf87683/source.mp4) — the prior hand
      // grid-read (0.29/0.145) undersized the head by roughly 2x once
      // actually run through computeSubjectTransform's calibration, which
      // is what motivated re-measuring headHeightFrac properly rather than
      // re-eyeballing it. edgeFalloff tuned against this job's own
      // measured render/reference edge-luma gap (see matte.ts's
      // applyLateralFalloff doc comment).
      talkingHead: {
        headTopFrac: 0.264,
        headHeightFrac: 0.17,
        lumaP50: 14,
        lumaP95: 76,
        faceLumaMean: 44.0,
        // Tuned via direct render-vs-reference verification on this job's
        // own footage (see the P1 build notes): minFactor 0.3/power 1.7
        // lands left-edge patch ~19-22 / right-edge patch ~8-10 against
        // the reference's own measured 27.4/7.3 — face/edge ratio 2.0-2.2,
        // meeting the plan's own >=2.0 acceptance bar.
        edgeFalloff: { minFactor: 0.3, power: 1.7 },
        // v6 fixes (measured against out/cinematic-debut-manifesto-2ec1ca.mp4
        // and the reference reel): the OLD faceLumaMean/p50 sample above mixed
        // hair/shadow into a fixed rectangle and read ~60-70; the real face
        // (p97 of the narrower hair/shadow-excluding region — see
        // officeCompositeQC.ts's measureFaceP97) measures ~116. Sharpness/
        // grain/warmth targets are the reference's own physical read on its
        // office plate; the FILTER PARAMETERS needed to hit them are solved
        // per job/plate (never baked in) — see solvePlateBlurSigma/
        // solveGrainStrength/solveWarmthShift.
        faceP97Target: 116,
        // Re-measured directly against the reference reel itself
        // (generation/officeCompositeQC.ts's measureFrameEdgeLuma, MEDIAN
        // over the same t=1.0-2.0s window as the framing measurements
        // above — stable at edge luma 20 throughout): 116/20 = 5.8, close
        // to office-composite rework's own independently-reported figure
        // (6.0-6.2, likely eyeballed against a slightly different patch).
        faceEdgeRatioTarget: 5.8,
        plateSharpnessRatioMid: 0.65,
        grainStdTarget: 3.4,
        roomWarmthTarget: 2.3,
        // Upper-left quadrant of the office-dark plate: above the subject's
        // own head band (headTopFrac 0.264) and clear of the desk foreground
        // (deskEdgeFrac 0.63) and the subject's own horizontal center — a
        // genuinely flat, texture-free patch of wall.
        flatBackdropRegion: { topFrac: 0.04, bottomFrac: 0.2, leftFrac: 0.06, rightFrac: 0.34 },
      },
      // Measured against measure-endcard.png (grid-overlay read): a tight
      // face-box reads p50~103 (well-lit skin), a sweater/torso box reads
      // p50~14 (near-black clothing) — the subject mask mixes both, weighted
      // toward clothing (more area), so p50 stays low like the talking-head
      // target while p95 sits well above it (bright skin highlight).
      endCard: { subjectTopFrac: 0.245, subjectHeightFrac: 0.52, lumaP50: 18, lumaP95: 130 },
    },
    musicSource: {
      path: "/Users/matsumotoshota/Desktop/Editable - template/Kumar/kumar-audio.mp3",
      startSec: 11.88,
      endSec: 20.0,
    },
  },
];

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const pngDimensions = (file: string): { width: number; height: number } => {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    file,
  ]).toString().trim();
  const [width, height] = out.split("x").map(Number);
  return { width, height };
};

/** Same histogram-percentile method as gates.ts's frameLumaStats, applied
 *  to a still image instead of a video frame at a given timestamp. */
const imageLumaStats = (file: string): { mean: number; p5: number; p50: number; p90: number; p95: number } => {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=180:320,format=gray", "-f", "rawvideo", "-"],
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

const buildDeskForeground = (officePath: string, outPath: string, edgeFrac: number): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", officePath,
    "-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((Y-(H*${edgeFrac}-12))/24*255,0,255)'`,
    outPath,
  ]);
};

const buildMusicBed = (src: string, startSec: number, endSec: number, outPath: string): number => {
  const durationSec = endSec - startSec;
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-ss", String(startSec), "-t", String(durationSec), "-i", src,
    "-af", "afade=t=in:d=0.3,afade=t=out:st=" + (durationSec - 0.6).toFixed(2) + ":d=0.6",
    "-c:a", "libmp3lame", "-q:a", "2",
    outPath,
  ]);
  return durationSec;
};

const buildOne = (cfg: FormatAssetConfig): void => {
  const dir = formatAssetsDir(cfg.formatId);
  fs.mkdirSync(dir, { recursive: true });

  type PlateEntry = { file: string; sha256: string; width: number; height: number; lumaStats: ReturnType<typeof imageLumaStats>; seatBandFrac?: { top: number; bottom: number } };
  const plates: Record<string, PlateEntry> = {};
  for (const [key, file] of Object.entries(cfg.plates)) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs)) throw new Error(`buildTemplateAssets: missing plate "${abs}" for "${cfg.formatId}"`);
    const { width, height } = pngDimensions(abs);
    plates[key] = { file, sha256: sha256(abs), width, height, lumaStats: imageLumaStats(abs), seatBandFrac: cfg.seatBands?.[key] };
  }

  // Generated plates have no source photo to check in — rendered fresh,
  // deterministically, from an existing matte.ts helper (same helper the
  // engine itself used to call for these looks before plates existed).
  for (const [key, kind] of Object.entries(cfg.generatedPlates ?? {})) {
    const file = `${key}.png`;
    const abs = path.join(dir, file);
    if (kind === "vignette") generateVignetteBackdrop(cfg.width, cfg.height, abs);
    else execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0xCABEC4:s=${cfg.width}x${cfg.height}`, "-frames:v", "1", abs]);
    plates[key] = { file, sha256: sha256(abs), width: cfg.width, height: cfg.height, lumaStats: imageLumaStats(abs), seatBandFrac: cfg.seatBands?.[key] };
  }

  const deskForegroundFile = "office-desk-foreground.png";
  const deskForegroundAbs = path.join(dir, deskForegroundFile);
  buildDeskForeground(path.join(dir, cfg.deskForegroundSource), deskForegroundAbs, cfg.deskEdgeFrac);

  let musicBed: { file: string; durationSec: number } | undefined;
  if (cfg.musicSource) {
    const file = "music-bed.mp3";
    const abs = path.join(dir, file);
    const durationSec = buildMusicBed(cfg.musicSource.path, cfg.musicSource.startSec, cfg.musicSource.endSec, abs);
    musicBed = { file, durationSec };
  }

  const manifest = PlatesManifestSchema.parse({
    formatId: cfg.formatId,
    plates,
    deskForeground: deskForegroundFile,
    deskEdgeFrac: cfg.deskEdgeFrac,
    reference: cfg.reference,
    musicBed,
  });

  fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(manifest, null, 2));
  console.log(`✔ ${cfg.formatId}: ${Object.keys(plates).length} plates, desk mask, ${musicBed ? `${musicBed.durationSec.toFixed(2)}s music bed` : "no music bed"}`);
};

const main = () => {
  const requested = process.argv[2];
  const targets = requested ? FORMATS.filter((f) => f.formatId === requested) : FORMATS;
  if (requested && targets.length === 0) {
    throw new Error(`buildTemplateAssets: no config for "${requested}" (known: ${FORMATS.map((f) => f.formatId).join(", ")})`);
  }
  for (const cfg of targets) buildOne(cfg);
};

main();

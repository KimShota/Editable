import { execFileSync } from "node:child_process";

/**
 * Kumar-style emphasis cutaway: crops+zooms the last `tailSec` of a video
 * into a tight close-up, cutting instantly at that point (a hard punch-in,
 * matching the reference reel's own edit rhythm — not a smooth Ken-Burns
 * zoom). Pure post-processing on footage that already exists; no
 * generation, no external call.
 *
 * ffmpeg's crop filter only evaluates its w/h expressions once at init
 * (despite advertising timeline support), so a single conditional crop
 * expression can't produce a cut partway through a clip — this instead
 * splits the video stream into an untouched head and a cropped tail via
 * trim+concat. Audio is passed straight through unmodified (`-c:a copy`,
 * no split/concat on that stream at all), so there's no seam risk on the
 * voice track from doing this.
 */
export const applyPunchInTail = (
  inputPath: string,
  outPath: string,
  opts: {
    durationSec: number;
    tailSec: number;
    width: number;
    height: number;
    /** Crop to this fraction of the frame's width/height before scaling
     *  back up — smaller = tighter zoom. */
    zoom?: number;
    /** Vertical bias of the crop window: 0 = top-aligned (favors a face
     *  near the top of frame), 1 = bottom-aligned. */
    yBias?: number;
    /** true for an alpha-carrying input/output (ProRes 4444, .mov, no
     *  audio) instead of the ordinary opaque libx264/.mp4 path — the
     *  karaokeTitle fg-alpha layer (matte.ts's compositeSubjectAlphaVideo)
     *  needs the SAME punch-in crop/zoom applied as the flattened
     *  composite it sits on top of, or the two layers shear apart during
     *  bold-claim's own punch-in tail (see backgroundReplace.ts's own
     *  doc comment on why the two layers must always move together). The
     *  crop/scale/concat filter graph itself is identical either way —
     *  only the codec/pix_fmt and audio mapping differ. */
    alpha?: boolean;
  },
): void => {
  const zoom = opts.zoom ?? 0.5;
  const yBias = opts.yBias ?? 0.25;
  const t0 = Math.max(0, opts.durationSec - opts.tailSec);

  const filterComplex = [
    "[0:v]split=2[va][vb]",
    `[va]trim=0:${t0},setpts=PTS-STARTPTS[va2]`,
    `[vb]trim=${t0},setpts=PTS-STARTPTS,crop=iw*${zoom}:ih*${zoom}:(iw-out_w)/2:(ih-out_h)*${yBias},scale=${opts.width}:${opts.height}[vb2]`,
    "[va2][vb2]concat=n=2:v=1:a=0[vout]",
  ].join(";");

  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    ...(opts.alpha ? [] : ["-map", "0:a?", "-c:a", "copy"]),
    ...(opts.alpha ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"] : []),
    outPath,
  ]);
};

/**
 * ECU (extreme close-up) cutaway: crops+zooms a short, silent window out
 * of an EXISTING clip — free, no generation, no matting, since it's
 * already the user's own footage at whatever grade its source clip
 * already carries (typically a background-replaced ANCHOR clip, so the
 * crop inherits that same dark look). Simpler than applyPunchInTail: a
 * standalone short window, not a cut partway through a longer clip
 * staying in place, so there's no split/concat needed — a single
 * `-ss`/`-t` extraction with the crop/zoom baked into the same pass. No
 * audio track at all (this is always used as a MUTED CutawayOverlay).
 */
export const extractCloseUpCutaway = (
  inputPath: string,
  outPath: string,
  opts: {
    atSec: number;
    durationSec: number;
    width: number;
    height: number;
    /** Crop to this fraction of the frame's width/height before scaling
     *  back up — smaller = tighter zoom. */
    zoom?: number;
    /** Vertical bias of the crop window: 0 = top-aligned (favors a face
     *  near the top of frame), 1 = bottom-aligned. */
    yBias?: number;
  },
): void => {
  const zoom = opts.zoom ?? 0.4;
  const yBias = opts.yBias ?? 0.2;
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-ss", String(opts.atSec),
    "-i", inputPath,
    "-t", String(opts.durationSec),
    "-vf", `crop=iw*${zoom}:ih*${zoom}:(iw-out_w)/2:(ih-out_h)*${yBias},scale=${opts.width}:${opts.height}`,
    "-an",
    outPath,
  ]);
};

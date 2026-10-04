import type { Edl } from "../pipeline/types";
import type { AdaptedScript, RecreationSpec } from "../recreation/schemas";
import { FPS, HEIGHT, WIDTH } from "./clips";
import { AI_VIDEO_FORMAT } from "./format";
import type { Timeline } from "./timeline";

/**
 * An adapted video as an EDL: the same document the Katalab editor and the
 * Remotion renderer already use. Nothing is burned in: every shot is its own
 * clip on the main track, every line its own voice clip, every title an
 * editable TextOverlay, every caption group an editable caption. Changing a
 * word, a title or a clip later means editing this document, not
 * regenerating the video.
 */

export type MadeClip = {
  /** public/-relative src, as the EDL references it. */
  src: string;
  /** Absolute path of the file, for staging. */
  file: string;
  durationSec: number;
  /** Where in the clip the shot starts (a lip-synced clip's speech offset). */
  inSec: number;
  /** How fast the clip plays (a lip-synced clip whose speech the model
   *  stretched plays faster to land on our voice); 1 when absent. */
  rate?: number;
};

export type VoiceFile = { src: string; file: string; durationSec: number };

/** Words per caption group, as in the source (2-4 words at a time). */
const MAX_CAPTION_WORDS = 3;

const TEXT_VARIANT: Record<string, string> = { hook_title: "hook", label: "title", cta: "cta", other: "title" };
/** Boxes as frame fractions. Titles stay clear of the captions in the middle. */
const TEXT_BOX: Record<string, { y: number; height: number }> = {
  top: { y: 0.08, height: 0.18 },
  middle: { y: 0.22, height: 0.16 },
  bottom: { y: 0.7, height: 0.16 },
};

export const captionGroups = (lines: Timeline["lines"]): Edl["captions"] => {
  const groups: Edl["captions"] = [];
  for (const line of lines) {
    let chunk: Timeline["lines"][number]["words"] = [];
    const flush = () => {
      if (chunk.length === 0) return;
      groups.push({
        id: `cap-${line.index}-${groups.length}`,
        words: chunk.map((w) => ({ text: w.text, tlStartSec: w.tlStartSec, tlEndSec: w.tlEndSec, emphasis: false })),
        tlInSec: chunk[0].tlStartSec,
        tlOutSec: chunk[chunk.length - 1].tlEndSec,
        variant: "lowerThird",
      });
      chunk = [];
    };
    for (const w of line.words) {
      chunk.push(w);
      // Break on a full group or at the end of a phrase.
      if (chunk.length >= MAX_CAPTION_WORDS || /[,.!?;:]$/.test(w.text)) flush();
    }
    flush();
  }
  // Hold each group until the next one starts (no flicker in short pauses).
  for (let i = 0; i < groups.length - 1; i++) {
    const gap = groups[i + 1].tlInSec - groups[i].tlOutSec;
    if (gap > 0 && gap < 0.6) groups[i].tlOutSec = groups[i + 1].tlInSec;
  }
  return groups;
};

export const compileEdl = (args: {
  jobId: string;
  script: AdaptedScript;
  spec: RecreationSpec;
  timeline: Timeline;
  clips: Map<string, MadeClip>;
  voice: Map<number, VoiceFile>;
}): Edl => {
  const { jobId, script, timeline, clips, voice } = args;
  const assets: Record<string, string> = {};
  const diagnostics: string[] = [];

  const video = timeline.shots.map((t) => {
    const clip = clips.get(t.shotId);
    if (!clip) throw new Error(`edl: no clip for ${t.shotId}`);
    assets[clip.src] = clip.file;
    const len = t.tlOutSec - t.tlInSec;
    const rate = clip.rate ?? 1;
    const available = clip.durationSec - clip.inSec;
    // A clip shorter than its shot plays slower instead of freezing, but
    // never past its usable end (a green-screen clip's clean part).
    const speed = available >= len * rate ? rate : available / len;
    if (speed < 0.5) diagnostics.push(`${t.shotId}: only ${available.toFixed(2)}s of usable clip for a ${len.toFixed(2)}s shot (plays at ${speed.toFixed(2)}x)`);
    return {
      id: t.shotId,
      blockId: t.shotId,
      src: clip.src,
      srcInSec: clip.inSec,
      srcOutSec: clip.inSec + len * speed,
      srcDurationSec: clip.durationSec,
      tlInSec: t.tlInSec,
      tlOutSec: t.tlOutSec,
      muted: true,
      speed,
      volume: 1,
      zoom: 1,
    };
  });

  const voiceovers = timeline.lines.map((l) => {
    const v = voice.get(l.index);
    if (!v) throw new Error(`edl: line ${l.index} has no voice`);
    assets[v.src] = v.file;
    const at = { tlInSec: l.tlInSec, tlOutSec: l.tlInSec + v.durationSec, srcInSec: 0, srcOutSec: v.durationSec };
    return { id: `line-${l.index}`, blockId: `line-${l.index}`, src: v.src, ...at, volume: 1, original: at };
  });

  const shotTimes = new Map(timeline.shots.map((s) => [s.shotId, s]));
  const overlays = script.shots.flatMap((shot) =>
    shot.textOnScreen.map((t, k) => {
      const at = shotTimes.get(shot.shotId)!;
      const box = TEXT_BOX[t.position] ?? TEXT_BOX.top;
      return {
        id: `text-${shot.shotId}-${k}`,
        component: "TextOverlay",
        params: { text: t.text, variant: TEXT_VARIANT[t.role] ?? "title" },
        tlInSec: at.tlInSec,
        tlOutSec: at.tlOutSec,
        x: 0.05,
        y: box.y,
        width: 0.9,
        height: box.height,
        states: [],
        layoutLocked: false,
      };
    }),
  );

  return {
    jobId,
    formatId: AI_VIDEO_FORMAT,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    durationSec: timeline.durationSec,
    video,
    voiceovers,
    overlays,
    sfx: [],
    captions: captionGroups(timeline.lines),
    captionStyle: { component: "Captions", params: { position: "center" } },
    transitions: [],
    music: [],
    tracks: [],
    assets,
    diagnostics,
  } as Edl;
};

/**
 * A regenerated shot into an EDL someone may already have edited: every
 * main-track segment cut from that shot (`blockId`, several after a split)
 * keeps its place and length on the timeline and its offset into the shot;
 * only the source changes. Everything else (titles, captions, trims of
 * other clips, music) is untouched.
 */
export const swapShotClip = (edl: Edl, shotId: string, clip: MadeClip): Edl => {
  const segments = edl.video.filter((v) => v.blockId === shotId).sort((a, b) => a.tlInSec - b.tlInSec);
  if (segments.length === 0) throw new Error(`edl: no clip of shot ${shotId} on the timeline`);
  const start = segments[0].tlInSec;
  const span = segments[segments.length - 1].tlOutSec - start;
  const rate = clip.rate ?? 1;
  const available = clip.durationSec - clip.inSec;
  const speed = available >= span * rate ? rate : available / span;
  const ids = new Set(segments.map((s) => s.id));
  return {
    ...edl,
    video: edl.video.map((v) => {
      if (!ids.has(v.id)) return v;
      const srcInSec = clip.inSec + (v.tlInSec - start) * speed;
      return { ...v, src: clip.src, srcInSec, srcOutSec: srcInSec + (v.tlOutSec - v.tlInSec) * speed, srcDurationSec: clip.durationSec, speed };
    }),
    assets: { ...edl.assets, [clip.src]: clip.file },
  };
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** The shortest piece of a voice line worth keeping when a clip's own audio takes over part of it. */
const MIN_KEPT_VOICE_SEC = 0.1;

/**
 * A shot played from its raw generated clip, with the clip's own audio instead of the ElevenLabs
 * voice. The clip keeps its slot on the timeline and plays there at natural speed (1x) from where
 * its speech starts (`raw.inSec`), unmuted: speech longer than the slot is cut.
 *
 * The voice lines under the slot are taken out so nothing speaks twice: a line inside the slot is
 * removed, one that runs past either edge is trimmed back to it (split in two if it spans the whole
 * slot). Captions are left alone.
 */
export const playRawClipAudio = (edl: Edl, shotId: string, raw: Pick<MadeClip, "src" | "file" | "durationSec" | "inSec">): Edl => {
  const segments = edl.video.filter((v) => v.blockId === shotId).sort((a, b) => a.tlInSec - b.tlInSec);
  if (segments.length === 0) throw new Error(`edl: no clip of shot ${shotId} on the timeline`);
  const from = segments[0].tlInSec;
  const to = segments[segments.length - 1].tlOutSec;
  const ids = new Set(segments.map((s) => s.id));

  const video = edl.video.map((v) => {
    if (!ids.has(v.id)) return v;
    const len = v.tlOutSec - v.tlInSec;
    // A main-track clip always fills its slot (its length is its source span), so one that would
    // run off the end of the raw clip starts that much earlier instead.
    const srcInSec = clamp(raw.inSec + (v.tlInSec - from), 0, Math.max(0, raw.durationSec - len));
    const srcOutSec = srcInSec + len;
    return { ...v, src: raw.src, srcInSec, srcOutSec, srcDurationSec: raw.durationSec, speed: 1, muted: false };
  });

  const voiceovers = edl.voiceovers.flatMap((l) => {
    if (l.tlOutSec <= from || l.tlInSec >= to) return [l];
    const pieces: Edl["voiceovers"] = [];
    if (l.tlInSec < from) pieces.push({ ...l, tlOutSec: from, srcOutSec: l.srcInSec + (from - l.tlInSec) });
    if (l.tlOutSec > to) pieces.push({ ...l, id: pieces.length ? `${l.id}-b` : l.id, tlInSec: to, srcInSec: l.srcInSec + (to - l.tlInSec) });
    return pieces
      .filter((p) => p.tlOutSec - p.tlInSec >= MIN_KEPT_VOICE_SEC)
      // A kept piece is its own generated line now: "back to the original position" must not
      // stretch it back under the clip.
      .map((p) => ({ ...p, original: { tlInSec: p.tlInSec, tlOutSec: p.tlOutSec, srcInSec: p.srcInSec, srcOutSec: p.srcOutSec } }));
  });

  return { ...edl, video, voiceovers, assets: { ...edl.assets, [raw.src]: raw.file } };
};

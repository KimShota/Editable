import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { requireWhisperModel, transcribeFile } from "./whisper";
import { buildShots, detectChangeTimes, extractFrame } from "./shotDetect";
import { beatBlockId, DiscoverBeat } from "./expandFormat";
import { loadReferenceBeats, ReferenceBeatSheet } from "./referenceBeats";
import { formatAssetsDir } from "./paths";
import { SPLIT_PIPELINE_VERSION, SplitTakeResult, TakeSplit } from "./splitTake";
import { FilledFormat, Format, Word } from "./types";

/**
 * Module 0 — Discover.
 *
 * Runs once, only for a format with a `repeat: true` block (see
 * BlockSchema's own doc comment) — finds however many "beats" the bound
 * speakingTakeSlot actually contains, since a long combined take (many
 * separately-filmed moments spliced into one file, no fixed count) can't
 * be described as a config-time list of blocks the way every other format
 * is. Everything this module does is generic across niches; the only
 * per-format knowledge it needs is `format.discovery.prompt` (what one
 * beat looks/sounds like here, and the tone of its generated text).
 *
 * Pipeline: whole-take whisper transcript (once) → candidate shots from
 * ffmpeg scene detection → one multimodal Anthropic call judging every
 * shot at once (which canonical beat it is, keep/drop, retake grouping,
 * sentence-continuation merging, a clockTime+caption, an importance
 * score) → deterministic code-side cleanup (retake dedupe, span snapping
 * to the words the model actually pointed at, length/count capping,
 * monotonic clockTime, and the running order itself). The
 * LLM is trusted for judgment (which shots matter, what they mean) but
 * NEVER for exact seconds — every span this module emits is derived from
 * real word timestamps or a shot's own real boundaries, never a
 * model-invented float.
 *
 * When the format ships a reference beat sheet (referenceBeats.ts —
 * derived from the creator's OWN published videos), this stops being an
 * open-ended "what's interesting in this footage?" judgment and becomes
 * a MATCHING one: every shot is asked which known beat it is, and the
 * final running order comes from the beat sheet, not from where the
 * moment happened to land in the raw file. That is what makes episode N+1
 * open on the same cold-open, greet the camera in the same place, and
 * sign off the same way as every episode before it — the thing a
 * creator's fixed format actually means. A format with no sheet falls
 * back to judging the footage from scratch, in source order.
 *
 * The result feeds TWO consumers: expandFormat.ts (turns each beat's own
 * `fields` into a concrete cloned block) and discoverResultToSplitTake
 * below (turns each beat's own `segments` into an ordinary splitTake.json
 * — see splitTake.ts's own doc comment on why writing that shape directly
 * means transcribe/trim/assemble need no changes at all to support this).
 */

/** ffmpeg's per-frame scene-change score (0..1) — lower than
 *  authoring/analyze.ts's own SCENE_THRESHOLD (0.3) because this is
 *  splicing together many separately-filmed phone clips, not detecting
 *  cuts within an already-edited reference reel; a real cut here is often
 *  a much subtler visual change (same room, different moment) than a
 *  produced video's hard scene changes. Erring FINE is deliberate: an
 *  over-segmented take costs a few more frames in the prompt and the
 *  model simply drops what it doesn't want, whereas an under-segmented
 *  one fuses two beats into a single shot that can only be assigned to
 *  one of them. */
const SCENE_THRESHOLD = 0.15;
/** Bounds prompt/image cost against a long or over-segmented take —
 *  downsampled evenly (see shotDetect's downsampleEvenly), not truncated,
 *  so a long day's footage still gets even coverage. */
const CANDIDATE_SHOT_CAP = 100;
/**
 * Longest window shown to the model as ONE candidate. Scene detection
 * finds where the camera stopped and started, which is not the same
 * question as "where is one usable moment": a single continuous take of a
 * bedroom runs nearly a minute and contains the bed being made, someone
 * walking about, AND the wake-up-and-greet-the-camera beat that is the
 * only part worth using. Presented whole, that shot gets ONE sampled
 * frame — the model is simply blind to the moment it is being asked to
 * find. So every scene-detected shot longer than this is cut into equal
 * windows, each with its own frame and its own candidate index, and the
 * model picks among those. Adjacent windows that turn out to be the same
 * moment are rejoined by `mergeWithPrevious`.
 */
const MAX_SUB_SHOT_SEC = 5;
const FRAME_WIDTH = 480;
/** A shot shorter than this isn't a moment, it's a detection artifact —
 *  a flash, a hand crossing the lens, the same real cut firing twice. Such
 *  a shot is MERGED into its predecessor rather than dropped: at the fine
 *  SCENE_THRESHOLD above, a spoken line routinely gets split by a stray
 *  boundary, and dropping the fragment (or keeping it as its own shot)
 *  is what turns "おはようございます、今日も一日元気にいきましょう" into a
 *  half-second stub. */
const MIN_SHOT_SEC = 1.0;
/** Padding kept around the words the model actually pointed at when
 *  snapping a picked span — same convention as splitTake.ts's own
 *  PAD_SEC. */
const PAD_SEC = 0.15;
/** Frames sampled from each beat's hand-cut exemplar (referenceBeats.ts)
 *  — first, middle and last, which is exactly enough to convey the
 *  framing AND the little arc a correct cut has (sits up → faces camera →
 *  thumbs-up), the part prose keeps failing to pin down. */
const EXEMPLAR_FRAMES = 3;
/** A dropped connection mid-stream (undici surfaces it as a bare
 *  "terminated") costs the whole run — whisper, scene detection and every
 *  extracted frame get thrown away with it. The request is large and
 *  long-running by nature, so a transient network failure is worth
 *  retrying rather than failing the build over. Only connection-level
 *  failures retry: a 4xx (bad request, no credit) is deterministic and
 *  retrying it just spends the same money twice. */
const MAX_ATTEMPTS = 3;
const DEFAULT_MODEL = "claude-opus-4-8";
/** Generous because it is a CEILING, not a spend: only tokens actually
 *  generated are billed. A judgment for every one of up to
 *  CANDIDATE_SHOT_CAP shots, plus the adaptive thinking that a
 *  many-image matching task genuinely needs, runs well past a
 *  20k budget — and a budget hit truncates the structured output
 *  mid-JSON, which surfaces as a parse failure rather than anything
 *  actionable (hence the explicit stop_reason check below). */
const MAX_TOKENS = 64000;

export const DISCOVER_PIPELINE_VERSION = "1";

export type DiscoverResult = {
  pipelineVersion: string;
  /** Whole-take words, take-relative seconds — carried through unchanged
   *  into splitTake.json (see discoverResultToSplitTake) so a cache hit
   *  off discovered.json never needs to re-run whisper. */
  words: Word[];
  durationSec: number;
  beats: DiscoverBeat[];
};

type Shot = {
  startSec: number;
  endSec: number;
  /** Bounds of the scene-detected shot this window was cut from — the
   *  same for every window of one continuous take. A timelapse beat is
   *  clamped to THESE rather than to its own window, since it needs tens
   *  of seconds of continuous footage and a window is only a few. */
  parentStartSec: number;
  parentEndSec: number;
};

/** Cuts each merged scene-detected shot into windows of at most
 *  `MAX_SUB_SHOT_SEC` (see its doc comment), widening that when the take
 *  is long enough that fixed windows would blow the candidate cap. */
const toSubShots = (shots: Array<{ startSec: number; endSec: number }>, durationSec: number): Shot[] => {
  const windowSec = Math.max(MAX_SUB_SHOT_SEC, durationSec / CANDIDATE_SHOT_CAP);
  return shots.flatMap((shot) => {
    const dur = shot.endSec - shot.startSec;
    const parts = Math.max(1, Math.ceil(dur / windowSec));
    const step = dur / parts;
    return Array.from({ length: parts }, (_, i) => ({
      startSec: shot.startSec + i * step,
      endSec: i === parts - 1 ? shot.endSec : shot.startSec + (i + 1) * step,
      parentStartSec: shot.startSec,
      parentEndSec: shot.endSec,
    }));
  });
};

const ShotJudgmentSchema = z.object({
  shotIndex: z.number().int(),
  keep: z.boolean(),
  /** Which canonical beat (referenceBeats.ts) this shot is an instance
   *  of — the sort key the final running order is built from. Omitted for
   *  a shot that matches no known beat (kept in place, between whichever
   *  matched beats surround it), and always omitted when the format ships
   *  no beat sheet at all. */
  referenceBeatId: z.string().optional(),
  /** Shots sharing the same id are re-takes of ONE beat — only one
   *  survives (see the retake-dedupe pass below). */
  retakeGroupId: z.string().optional(),
  /** Which member of a retake group to actually keep. */
  best: z.boolean().default(false),
  /** This shot's own speech continues the immediately preceding KEPT
   *  shot's sentence, rather than starting a new beat. */
  mergeWithPrevious: z.boolean().default(false),
  /** Inclusive, SHOT-LOCAL indices into the numbered LINES this shot was
   *  shown with — which spoken line(s) to actually keep. Omit both only
   *  for a shot with no speech to anchor on. */
  startLineIndex: z.number().int().min(0).optional(),
  endLineIndex: z.number().int().min(0).optional(),
  clockTime: z.string().optional(),
  caption: z.string().default(""),
  importance: z.number().min(0).max(1).default(0.5),
});

const DiscoverLlmOutputSchema = z.object({
  /** A short multi-line title card for the whole video — real newline
   *  characters between lines, in the style format.discovery.prompt
   *  describes. */
  title: z.string(),
  shots: z.array(ShotJudgmentSchema),
});

/** Minutes-since-midnight of the FIRST time in a clock string. Not
 *  anchored to the whole string on purpose: a timelapse beat's clock is a
 *  RANGE ("10:30〜11:30"), and its start is what the running order and the
 *  monotonic check care about. */
const parseClockMinutes = (s: string): number | null => {
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59) return null;
  return hours * 60 + minutes;
};

const formatClockMinutes = (mins: number): string => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;

/** Drops a leading "H:MM" line from a caption. The reference episodes burn
 *  the time and the caption as ONE text block, so a beat sheet built from
 *  them teaches captions that start with a clock — but this format renders
 *  the time as its own overlay, and a caption that repeats it prints the
 *  time twice. Belt-and-braces with the prompt rule that says the same. */
const stripLeadingClock = (caption: string): string =>
  caption.replace(/^\s*\d{1,2}\s*[:：]\s*\d{2}\s*(?:〜\s*\d{1,2}\s*[:：]\s*\d{2}\s*)?\n?/, "").trim();

const buildShotWords = (words: Word[], shot: Shot): Word[] =>
  words.filter((w) => w.startSec >= shot.startSec && w.startSec < shot.endSec);

/** A pause this long between consecutive words reads as the boundary
 *  between two separately-spoken LINES — same idea (and nearly the same
 *  threshold) as splitTake.ts's own UTTERANCE_GAP_SEC, reimplemented here
 *  because that one isn't exported and this module groups a single shot's
 *  words rather than a whole take's. */
const UTTERANCE_GAP_SEC = 0.6;

type Utterance = { words: Word[]; startSec: number; endSec: number };

/** Groups a shot's own words into pause-separated spoken lines. Whisper
 *  returns Japanese as one token per character (see whisper.ts), so raw
 *  word indices are a hopeless unit for a model to point at — a LINE is
 *  the unit a human editor actually cuts on, and it's what the model is
 *  asked to choose between. */
const utterancesOf = (words: Word[]): Utterance[] => {
  const utterances: Utterance[] = [];
  let current: Word[] = [];
  for (const w of words) {
    const prev = current[current.length - 1];
    if (prev && w.startSec - prev.endSec > UTTERANCE_GAP_SEC) {
      utterances.push({ words: current, startSec: current[0].startSec, endSec: prev.endSec });
      current = [];
    }
    current.push(w);
  }
  if (current.length > 0) {
    utterances.push({ words: current, startSec: current[0].startSec, endSec: current[current.length - 1].endSec });
  }
  return utterances;
};

const formatShotUtterances = (utterances: Utterance[]): string =>
  utterances.length === 0
    ? "    (no speech in this shot)"
    : utterances
        .map(
          (u, i) =>
            `    [${i}] "${u.words.map((w) => w.text).join("")}" (${u.startSec.toFixed(1)}s-${u.endSec.toFixed(1)}s, ${(u.endSec - u.startSec).toFixed(1)}s)`,
        )
        .join("\n");

/** The beat sheet, rendered for the prompt — the creator's own format,
 *  stated as the thing to match against rather than something for the
 *  model to infer episode by episode. */
const formatBeatSheet = (sheet: ReferenceBeatSheet): string =>
  sheet.beats
    .map((b) => {
      const bits = [
        `- id "${b.id}" (position ${b.order}${b.isTitleBeat ? ", THE COLD OPEN — carries the title card" : ""}${b.optional ? ", optional" : ", appears in every episode"})`,
        `  ${b.label}: ${b.description}`,
      ];
      if (b.typicalClockTime) bits.push(`  usual time: ${b.typicalClockTime}`);
      if (b.captionExamples.length > 0) {
        bits.push(`  captions used on this beat: ${b.captionExamples.map((c) => JSON.stringify(c)).join(" / ")}`);
      }
      if (b.speed > 1) {
        bits.push(
          `  TIMELAPSE beat: this one is played back at ${b.speed}x, so pick a LONG stretch of it (roughly ${b.speed}x what a normal cut would be) — the finished cut is short but the footage inside it is the whole activity, sped up. Its caption/time should read as a RANGE covering how long it actually went on (e.g. "10:30〜11:30"), not a single instant.`,
        );
      }
      for (const ex of b.exemplars) {
        const perCut = ex.durationSec ? ex.durationSec / ex.shotCount : undefined;
        bits.push(
          `  HAND-CUT EXAMPLE ATTACHED for this beat (labelled "EXEMPLAR ${b.id}" below): the creator trimmed this beat themselves out of their own raw footage, so it is the standard your cut of this beat is judged against — match its framing, its starting moment and its ending moment.`,
        );
        if (perCut) {
          bits.push(
            `  their own version runs ${ex.durationSec!.toFixed(1)}s across ${ex.shotCount} cut(s) — about ${perCut.toFixed(1)}s per cut.`,
          );
        }
        if (ex.rule) bits.push(`  rule for this beat: ${ex.rule}`);
      }
      return bits.join("\n");
    })
    .join("\n\n");

const buildPrompt = (
  format: Format,
  shots: Shot[],
  shotUtterances: Utterance[][],
  durationSec: number,
  sheet: ReferenceBeatSheet | null,
): string => {
  const discovery = format.discovery!;
  const shotBlocks = shots
    .map(
      (s, i) =>
        `Shot ${i} — ${s.startSec.toFixed(2)}s to ${s.endSec.toFixed(2)}s (${(s.endSec - s.startSec).toFixed(1)}s). Lines spoken:\n${formatShotUtterances(shotUtterances[i])}`,
    )
    .join("\n\n");

  const referenceSection = sheet
    ? `THIS CREATOR'S FIXED FORMAT — every episode is built from these beats, in this order:

${formatBeatSheet(sheet)}

Your PRIMARY job is to find each of these beats in today's raw footage. For every shot, set "referenceBeatId" to the id of the beat it is an instance of, or omit it if the shot matches none of them. Several consecutive shots can belong to the SAME beat — that is normal and wanted (the reference episodes cut a single beat into two or three quick shots, e.g. holding the product up, then drinking, then the thumbs-up reaction). Keep them all and give them the same referenceBeatId.

Match on what the shot actually shows and says, not on where it sits in the file — the raw footage is roughly chronological but the finished edit's order comes from the beat sheet above, so a beat filmed out of order still belongs to its beat.

Write each "caption" in the SAME voice as that beat's own caption examples above: same length, same register, same phrasing habits. Use today's actual content — never copy an example verbatim unless today's footage genuinely shows the same thing.

`
    : "";

  const titleInstruction = sheet?.beats.find((b) => b.isTitleBeat)
    ? `Also give a "title" for today's episode: the multi-line title card for the cold-open beat, following the exact pattern of that beat's caption examples above (same fixed lines, with the middle line describing what makes TODAY different), using real newline characters between lines.`
    : `Also give a "title": a short multi-line Japanese title card for the whole video (use real newline characters between lines), in the style the guidance above describes.`;

  return `You are editing a ${durationSec.toFixed(0)}-second file (one person's phone footage of a whole day, filmed as many separate short clips spliced back to back with no gaps) into a fast-cut highlight reel — the SAME edit format every time, only the footage changes.

FORMAT-SPECIFIC GUIDANCE FOR THIS NICHE:
${discovery.prompt}

${referenceSection}The file was auto-split into ${shots.length} candidate WINDOWS — first at the hard visual cuts, then any long stretch of continuous footage chopped into a few seconds each, so that a single unbroken take (a whole minute in a bedroom, say) is offered to you as several windows rather than one. Consecutive windows are therefore often the same continuous footage: the camera did not cut between them, and one real moment may run across two of them (use "mergeWithPrevious" for that). Each window below is shown with its time range and every word actually spoken in it (lines indexed from 0, window-local, NOT the same index across windows). One frame from each window is attached, in the same order, each labeled "Shot N" right before its image.

${shotBlocks}

HOW TO CHOOSE A CUT (these are the mistakes that get corrected by hand most often):
- Never use the seconds where the camera is being set up or picked up — handheld wobble, the subject's back, a half-empty frame, someone walking into position. That footage is at the START of a filmed moment almost every time, so the usable part of a shot usually begins AFTER it.
- Prefer the settled part of a moment: the framing has stopped moving, the subject is in frame, and something is actually happening (a line spoken, a reaction, a thumbs-up, a product held up).
- End a cut on its payoff — the reaction, the gesture, the end of the sentence — not partway through it and not on the dead air afterwards.
- Nothing-happening footage (walking around, tidying, fiddling with things, staring off) is not a beat, however long it runs.

For EVERY shot from 0 to ${shots.length - 1}, decide:
- "keep": should this moment appear in the final edit? Drop dead air, camera fumbling/setup with nothing worth showing, and a clearly worse duplicate of another shot.
- "retakeGroupId": shots that are re-takes of the SAME beat (the person messed up and redid the same line/action) all get the SAME short id string, e.g. "retake-1". Leave unset for a shot that stands alone. Do NOT use this for the several distinct shots that make up one beat — those are all kept.
- "best": within a retake group, true on the ONE shot to actually use (usually the last, cleanest attempt); false everywhere else, including every shot outside a group.
- "mergeWithPrevious": true when this window is the SAME continuous moment as the immediately preceding KEPT one — a sentence running across the boundary, or one action (sitting up and then giving the thumbs-up, holding a product up and then showing it) that the windowing split in half. Not merely the same topic or the same location.
- "startLineIndex"/"endLineIndex": inclusive shot-local indices into that shot's numbered "Lines spoken" list — which complete line(s) to keep. Whenever the shot has ANY speech worth keeping you MUST set these; a greeting like "おはようございます / 今日も一日元気にいきましょう" spread over two lines means startLineIndex 0 and endLineIndex 1, so the whole greeting survives as one cut. Never keep a fragment of a line, and never leave these unset just because the shot is short. Omit both ONLY for a shot with no speech at all (a purely visual beat).
- "clockTime": a PLACEHOLDER time-of-day, "H:MM" (24-hour, no leading zero on H — e.g. "9:00", "22:10"). Read it off an on-screen clock/phone/watch/smart-speaker when one is visible, otherwise use the usual time for that beat above. This is a starting value the creator corrects by hand afterwards, so a plausible time is enough — do not spend effort agonising over it, and never let it change which shots you keep or how you caption them.
- "caption": a short, casual Japanese caption for the moment, in the style described above. Write the caption text ONLY — never put the time in it. The time is rendered as its own separate line on screen from "clockTime", so a caption like "10:00\n起床" would show the time twice; the caption for that shot is just "起床". Leave "caption" empty for a shot on the cold-open/title beat: that beat shows the title card alone, with no caption under it.
- "importance": 0-1, how essential this moment is if some have to be cut for total length. Beats the format has in every episode outrank one-off colour.

${titleInstruction}

Return exactly one judgment per shot index, covering every index from 0 to ${shots.length - 1}.`;
};

export const discover = async (format: Format, filled: FilledFormat): Promise<DiscoverResult> => {
  if (!format.discovery) {
    throw new Error(`discover: format "${format.id}" has no "discovery" config`);
  }
  if (!format.speakingTakeSlot) {
    throw new Error(`discover: format "${format.id}" has no speakingTakeSlot`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "discover: requires ANTHROPIC_API_KEY (put it in .env) — beat discovery is multimodal (it reads sampled frames) and needs the Anthropic API; the render pipeline itself stays keyless.",
    );
  }
  const take = filled.bindings[format.speakingTakeSlot.name];
  if (take?.type !== "file" || take.durationSec === undefined) {
    throw new Error(`discover: speakingTakeSlot "${format.speakingTakeSlot.name}" is not bound to a file with a known duration`);
  }
  const durationSec = take.durationSec;
  const discovery = format.discovery;
  // The creator's own format, when one has been derived from their
  // published videos (see referenceBeats.ts) — absent is fine, discovery
  // then judges the footage from scratch and keeps it in source order.
  const sheet = loadReferenceBeats(format.id);
  const beatOrderById = new Map(sheet ? sheet.beats.map((b) => [b.id, b.order]) : []);
  const titleBeatId = sheet?.beats.find((b) => b.isTitleBeat)?.id;
  // Target length for ONE cut of a beat: the longest per-cut length among
  // that beat's own hand-cut examples (a two-shot example's total is not
  // the length of one cut — see the exemplar's own shotCount).
  const exemplarSecById = new Map(
    (sheet?.beats ?? []).flatMap((b) => {
      const perCut = b.exemplars.flatMap((ex) => (ex.durationSec ? [ex.durationSec / ex.shotCount] : []));
      return perCut.length > 0 ? [[b.id, Math.max(...perCut)] as const] : [];
    }),
  );
  const speedById = new Map((sheet?.beats ?? []).flatMap((b) => (b.speed !== 1 ? [[b.id, b.speed] as const] : [])));
  /** The sheet's last beat is the sign-off — the one beat that belongs at
   *  the END of the cut regardless of what its clock says (the reference
   *  episodes close on it after the day is over). */
  const signoffBeatId = sheet && sheet.beats.length > 0 ? sheet.beats[sheet.beats.length - 1].id : undefined;

  requireWhisperModel();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-discover-"));
  try {
    const words = transcribeFile(take.absPath, workDir, filled.language);

    const changeTimes = detectChangeTimes(take.absPath, SCENE_THRESHOLD);
    const rawShots = buildShots(changeTimes, durationSec, CANDIDATE_SHOT_CAP);
    const merged = rawShots.reduce<Array<{ startSec: number; endSec: number }>>((acc, shot) => {
      const prev = acc[acc.length - 1];
      if (prev && shot.endSec - shot.startSec < MIN_SHOT_SEC) prev.endSec = shot.endSec;
      else acc.push({ ...shot });
      return acc;
    }, []);
    const shots = toSubShots(merged, durationSec);
    console.log(`discover: ${merged.length} scene-detected shots → ${shots.length} candidate windows`);
    const shotUtterances = shots.map((s) => utterancesOf(buildShotWords(words, s)));

    const framesDir = path.join(workDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const imageBlocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];

    // The hand-cut examples go FIRST, so the standard for a beat is on
    // screen before any candidate is judged against it. Sampled at the
    // start, middle and end of each exemplar: a correct cut is as much
    // about where it BEGINS and ENDS as about what is in it.
    for (const beat of sheet?.beats ?? []) {
      for (const [exIdx, ex] of beat.exemplars.entries()) {
      const clipPath = path.join(formatAssetsDir(format.id), ex.clip);
      if (!fs.existsSync(clipPath)) {
        console.warn(`discover: beat "${beat.id}" names exemplar "${ex.clip}" but ${clipPath} is missing — skipping it`);
        continue;
      }
      const exemplarDur = ex.durationSec ?? 3;
      // One extra frame per additional cut, so a two-shot example shows
      // both of its shots rather than straddling the cut between them.
      const frames = EXEMPLAR_FRAMES + (ex.shotCount - 1);
      for (let k = 0; k < frames; k++) {
        // Nudged inside the clip so the last sample isn't past the final frame.
        const atSec = Math.min(exemplarDur - 0.05, (exemplarDur * k) / (frames - 1));
        const framePath = path.join(framesDir, `exemplar_${beat.id}_${exIdx}_${k}.jpg`);
        if (!extractFrame(clipPath, Math.max(0, atSec), framePath, FRAME_WIDTH)) continue;
        imageBlocks.push(
          {
            type: "text",
            text: `EXEMPLAR ${beat.id} (${exIdx + 1}) — frame ${k + 1}/${frames} of the creator's own hand-cut version of the "${beat.label}" beat`,
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(framePath).toString("base64") },
          },
        );
      }
      }
    }
    shots.forEach((s, i) => {
      const lines = shotUtterances[i];
      const atSec = lines.length > 0 ? (lines[0].startSec + lines[lines.length - 1].endSec) / 2 : (s.startSec + s.endSec) / 2;
      const framePath = path.join(framesDir, `shot_${String(i).padStart(3, "0")}.jpg`);
      const ok = extractFrame(take.absPath, atSec, framePath, FRAME_WIDTH);
      if (!ok) {
        console.warn(`discover: failed to extract frame for shot ${i} at ${atSec.toFixed(2)}s — judging from words only`);
        return;
      }
      const data = fs.readFileSync(framePath).toString("base64");
      imageBlocks.push(
        { type: "text", text: `Shot ${i}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
      );
    });

    const client = new Anthropic();
    const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;
    const promptText = buildPrompt(format, shots, shotUtterances, durationSec, sheet);
    // Streamed, not parse(): the SDK requires streaming once a request may
    // run past 10 minutes, which a 70-image call with adaptive thinking
    // does. finalMessage() still carries parsed_output from output_config.
    const request = () =>
      client.messages
        .stream({
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          messages: [{ role: "user", content: [{ type: "text", text: promptText }, ...imageBlocks] }],
          output_config: { format: zodOutputFormat(DiscoverLlmOutputSchema) },
        })
        .finalMessage();

    let response: Awaited<ReturnType<typeof request>> | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        response = await request();
        break;
      } catch (err) {
        // An API error carries a status; anything without one reached us
        // as a transport failure (connection dropped, DNS, timeout) and
        // is worth another go.
        const status = (err as { status?: number }).status;
        if (status !== undefined || attempt === MAX_ATTEMPTS) throw err;
        console.warn(
          `discover: attempt ${attempt}/${MAX_ATTEMPTS} lost the connection (${(err as Error).message}) — retrying`,
        );
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (!response) throw new Error("discover: no response after retries");
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `discover: the model hit the ${MAX_TOKENS}-token budget before finishing its judgment of ${shots.length} shots — ` +
          "raise MAX_TOKENS, or lower CANDIDATE_SHOT_CAP so there are fewer shots to judge.",
      );
    }
    if (!response.parsed_output) {
      throw new Error("discover: model response did not match the expected schema");
    }
    const llm = response.parsed_output;
    const judgmentByShot = new Map(llm.shots.map((s) => [s.shotIndex, s]));

    type Candidate = {
      shot: Shot;
      words: Word[] | undefined;
      clockTime?: string;
      caption: string;
      retakeGroupId?: string;
      best: boolean;
      mergeWithPrevious: boolean;
      importance: number;
      /** Canonical position from the beat sheet, or undefined when this
       *  shot matched no known beat (or there is no sheet). */
      refOrder?: number;
      isTitle: boolean;
      isSignoff: boolean;
      /** How long the creator's own hand-cut version of this beat runs,
       *  when they registered one — a per-beat length target that beats
       *  the format-wide maxBeatSec, since it was measured on this exact
       *  beat rather than averaged over all of them. */
      exemplarSec?: number;
      /** >1 for a beat the sheet marks as a timelapse — every length
       *  budget below is in TIMELINE seconds, so this beat gets to
       *  consume `speed` times as much SOURCE to fill the same space. */
      speed: number;
    };
    const candidates: Candidate[] = [];
    shots.forEach((shot, i) => {
      const j = judgmentByShot.get(i);
      if (!j || !j.keep) return;
      const lines = shotUtterances[i];
      let picked: Word[] | undefined;
      if (
        j.startLineIndex !== undefined &&
        j.endLineIndex !== undefined &&
        j.startLineIndex <= j.endLineIndex &&
        j.endLineIndex < lines.length
      ) {
        picked = lines.slice(j.startLineIndex, j.endLineIndex + 1).flatMap((u) => u.words);
      } else if (lines.length > 0) {
        // The model left the line range unset on a shot that DOES have
        // speech — its own guidance says not to, but a positional
        // fallback (every line in the shot) still beats the silent-beat
        // default window, which would land wherever the shot's midpoint
        // happens to be and clip the line in half.
        picked = lines.flatMap((u) => u.words);
      }
      const refOrder = j.referenceBeatId ? beatOrderById.get(j.referenceBeatId) : undefined;
      const isTitleShot = j.referenceBeatId !== undefined && titleBeatId === j.referenceBeatId;
      const exemplarSec = j.referenceBeatId ? exemplarSecById.get(j.referenceBeatId) : undefined;
      const speed = (j.referenceBeatId ? speedById.get(j.referenceBeatId) : undefined) ?? 1;
      if (j.referenceBeatId && refOrder === undefined) {
        console.warn(`discover: shot ${i} claims unknown reference beat "${j.referenceBeatId}" — keeping it in source order`);
      }
      candidates.push({
        shot,
        words: picked,
        clockTime: j.clockTime,
        // The title beat renders the title card alone (the reference
        // episodes put no caption under it), and no caption anywhere
        // repeats the clock — that is a separate overlay, so a model-
        // written "10:00\n起床" would print the time twice on screen.
        caption: isTitleShot ? "" : stripLeadingClock(j.caption),
        retakeGroupId: j.retakeGroupId,
        best: j.best,
        mergeWithPrevious: j.mergeWithPrevious,
        importance: j.importance,
        refOrder,
        isTitle: isTitleShot,
        isSignoff: j.referenceBeatId !== undefined && signoffBeatId === j.referenceBeatId,
        exemplarSec,
        speed,
      });
    });

    // Retake dedupe: within each shared retakeGroupId, keep only the
    // model-flagged "best" member (first if it flagged more than one),
    // falling back to the LAST shot in the group when none was flagged.
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!c.retakeGroupId) continue;
      if (!groups.has(c.retakeGroupId)) groups.set(c.retakeGroupId, []);
      groups.get(c.retakeGroupId)!.push(c);
    }
    const dropped = new Set<Candidate>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const chosen = group.find((c) => c.best) ?? group[group.length - 1];
      for (const c of group) if (c !== chosen) dropped.add(c);
    }
    const survivors = candidates.filter((c) => !dropped.has(c));
    if (survivors.length === 0) {
      throw new Error("discover: every candidate shot was dropped or de-duped away — nothing usable in this footage");
    }

    const computeSpan = (c: Candidate): { srcInSec: number; srcOutSec: number; confidence: number } => {
      const { shot, words: picked } = c;
      // A beat the creator hand-cut has a measured length of its own;
      // trust that over the format-wide average, with a little headroom
      // so the cut isn't clipped exactly at the exemplar's frame count.
      const maxTimelineSec = c.exemplarSec ? Math.max(discovery.maxBeatSec, c.exemplarSec * 1.2) : discovery.maxBeatSec;
      // Every budget in `discovery` is stated in FINISHED (timeline)
      // seconds. A timelapse beat plays `speed`x faster, so it may eat
      // `speed` times as many SOURCE seconds to occupy the same slot —
      // which is the whole point: an hour of practice becomes three
      // seconds on screen.
      const maxSec = maxTimelineSec * c.speed;
      const minSec = discovery.minBeatSec * c.speed;
      // A timelapse beat needs tens of seconds of continuous footage —
      // far more than one window holds — so it is bounded by the whole
      // scene-detected take the window was cut from. Everything else
      // stays inside its own window, which is what keeps ordinary cuts
      // tight.
      const lowSec = c.speed > 1 ? shot.parentStartSec : shot.startSec;
      const highSec = c.speed > 1 ? shot.parentEndSec : shot.endSec;
      if (picked && picked.length > 0) {
        let start = Math.max(lowSec, picked[0].startSec - PAD_SEC);
        let end = Math.min(highSec, picked[picked.length - 1].endSec + PAD_SEC);
        const dur = end - start;
        if (dur < minSec) {
          const grow = (minSec - dur) / 2;
          start = Math.max(lowSec, start - grow);
          end = Math.min(highSec, end + grow);
        } else if (dur > maxSec) {
          // Trim the TAIL, never the head: a spoken line's opening words
          // are what make the cut read as a complete thought ("おはよう
          // ございます…"), and a symmetric shrink would clip exactly
          // those. An over-long beat loses its trailing pause instead.
          end = start + maxSec;
        }
        return { srcInSec: start, srcOutSec: Math.max(start + 0.2, end), confidence: 0.7 };
      }
      // No words to anchor on — a silent/visual beat: center a default
      // window on the shot's own midpoint, never wider than the shot
      // itself. Lower confidence: a positional guess, not a real match.
      const shotDur = highSec - lowSec;
      const targetDur = Math.min(shotDur, (c.exemplarSec ?? (discovery.minBeatSec + discovery.maxBeatSec) / 2) * c.speed);
      const mid = (shot.startSec + shot.endSec) / 2;
      const start = Math.max(lowSec, mid - targetDur / 2);
      const end = Math.min(highSec, start + targetDur);
      return { srcInSec: start, srcOutSec: Math.max(start + 0.2, end), confidence: 0.3 };
    };

    type Beat = {
      segments: { srcInSec: number; srcOutSec: number; confidence: number }[];
      clockTime?: string;
      caption: string;
      importance: number;
      refOrder?: number;
      isTitle: boolean;
      isSignoff: boolean;
      speed: number;
      /** Where this beat's footage starts in the source take — the
       *  tiebreaker within one canonical beat, so the two or three shots
       *  that make up e.g. "breakfast" still play in the order they were
       *  actually filmed. */
      sourceStartSec: number;
    };
    const beats: Beat[] = [];
    for (const c of survivors) {
      const span = computeSpan(c);
      if (c.mergeWithPrevious && beats.length > 0) {
        // Appended as a SECOND segment on the previous beat, not a new
        // beat — deriveTranscriptAndTrim (splitTake.ts) concatenates
        // same-blockId segments in array order, which is exactly what a
        // sentence split across two takes needs.
        const prev = beats[beats.length - 1];
        prev.segments.push(span);
        prev.importance = Math.max(prev.importance, c.importance);
        continue;
      }
      beats.push({
        segments: [span],
        clockTime: c.clockTime,
        caption: c.caption,
        importance: c.importance,
        refOrder: c.refOrder,
        isTitle: c.isTitle,
        isSignoff: c.isSignoff,
        speed: c.speed,
        sourceStartSec: span.srcInSec,
      });
    }

    // The running order is the SOURCE order — the day's clips are handed
    // over already in the order they were filmed, which makes filming
    // order the one piece of chronology in this pipeline that is known
    // rather than inferred. Only two beats move: the cold open (pulled
    // from anywhere in the day, always first) and the sign-off (always
    // last), exactly the two exceptions the reference episodes make.
    // Deliberately NOT sorted by the model's own clockTime: those are
    // placeholders for the user to correct afterwards, so ordering by
    // them would let a bad guess reorder footage that was already right.
    if (sheet) {
      const TITLE_KEY = Number.NEGATIVE_INFINITY;
      const SIGNOFF_KEY = Number.POSITIVE_INFINITY;
      const sortKey = (b: Beat) => (b.isTitle ? TITLE_KEY : b.isSignoff ? SIGNOFF_KEY : b.sourceStartSec);
      beats.sort((a, b) => sortKey(a) - sortKey(b) || a.sourceStartSec - b.sourceStartSec);
    }

    // Windows rejoined by mergeWithPrevious are adjacent slices of ONE
    // continuous take, and each was independently padded/grown by
    // computeSpan — so their spans routinely overlap. Left alone, the
    // same footage is laid down twice, which reads as a stutter. Coalesce
    // each beat's own overlapping or touching spans into single runs.
    for (const beat of beats) {
      const sorted = [...beat.segments].sort((a, b) => a.srcInSec - b.srcInSec);
      const coalesced: typeof beat.segments = [];
      for (const seg of sorted) {
        const prev = coalesced[coalesced.length - 1];
        if (prev && seg.srcInSec <= prev.srcOutSec + 0.05) {
          prev.srcOutSec = Math.max(prev.srcOutSec, seg.srcOutSec);
          prev.confidence = Math.max(prev.confidence, seg.confidence);
        } else {
          coalesced.push({ ...seg });
        }
      }
      beat.segments = coalesced;
    }

    // A beat that ended up under the format's own minimum isn't a beat —
    // it's a scene-detect fragment that survived selection (a half-second
    // of a desk, a single frame of a pan). Dropped rather than rendered
    // as a blink-and-miss cut with a caption on it.
    const tooShort = beats.filter(
      (b) => b.segments.reduce((sum, s) => sum + (s.srcOutSec - s.srcInSec), 0) / b.speed < discovery.minBeatSec,
    );
    for (const b of tooShort) {
      const idx = beats.indexOf(b);
      if (idx !== -1 && beats.length > 1) beats.splice(idx, 1);
    }

    /** FINISHED length of a beat — source span divided by its own
     *  playback rate, which is what the format's targetTotalSec budget is
     *  actually denominated in. */
    const beatDurationSec = (b: Beat) => b.segments.reduce((sum, s) => sum + (s.srcOutSec - s.srcInSec), 0) / b.speed;
    const dropLowestImportanceUntil = (done: () => boolean) => {
      while (!done() && beats.length > discovery.minBeats) {
        let lowestIdx = 0;
        for (let i = 1; i < beats.length; i++) {
          if (beats[i].importance < beats[lowestIdx].importance) lowestIdx = i;
        }
        beats.splice(lowestIdx, 1);
      }
    };
    dropLowestImportanceUntil(() => beats.length <= discovery.maxBeats);
    dropLowestImportanceUntil(() => beats.reduce((sum, b) => sum + beatDurationSec(b), 0) <= discovery.targetTotalSec);

    // Clock times must read forward through the day — a beat the model
    // left blank inherits the previous beat's time, and any regression
    // clamps to the previous beat's time rather than visibly jumping
    // backward.
    let lastMinutes: number | null = null;
    for (const beat of beats) {
      // The cold open and the sign-off carry no time in the reference
      // episodes — the title card and the closing line stand alone.
      if (beat.isTitle || beat.isSignoff) {
        beat.clockTime = "";
        continue;
      }
      const parsed = beat.clockTime ? parseClockMinutes(beat.clockTime) : null;
      if (parsed !== null) {
        // Kept verbatim, even when it reads earlier than the beat before
        // it. These are PLACEHOLDERS the creator corrects by hand, and
        // clamping a stray guess forward used to pin every later beat to
        // it — one bad reading turning the whole afternoon into "21:28".
        // A single wrong time is a one-field fix; a cascade is not.
        lastMinutes = parsed;
        continue;
      }
      // No usable time at all — inherit the previous beat's rather than
      // print a blank line under the caption.
      beat.clockTime = lastMinutes !== null ? formatClockMinutes(lastMinutes) : "";
    }

    const discoverBeats: DiscoverBeat[] = beats.map((b, i) => ({
      fields: { clockTime: b.clockTime ?? "", caption: b.caption, title: i === 0 ? llm.title : "" },
      segments: b.segments,
      speed: b.speed,
    }));

    return { pipelineVersion: DISCOVER_PIPELINE_VERSION, words, durationSec, beats: discoverBeats };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** Rebuilds splitTake.json's own shape (see splitTake.ts) from a
 *  DiscoverResult — cheap and deterministic, so orchestrate.ts can
 *  regenerate it on every build (including a cache hit off
 *  discovered.json) instead of persisting a second, easily-stale copy of
 *  the same spans. `format` must already carry the `repeat` template
 *  block discovery ran against (the BASE format, before expandFormat). */
export const discoverResultToSplitTake = (format: Format, discovered: DiscoverResult): SplitTakeResult => {
  const template = format.blocks.find((b) => b.repeat);
  if (!template) {
    throw new Error(`discoverResultToSplitTake: format "${format.id}" has no repeat block`);
  }
  const blocks: TakeSplit[] = discovered.beats.flatMap((beat, i) =>
    beat.segments.map((seg) => ({
      blockId: beatBlockId(template.id, i),
      srcInSec: seg.srcInSec,
      srcOutSec: seg.srcOutSec,
      confidence: seg.confidence,
    })),
  );
  return { words: discovered.words, durationSec: discovered.durationSec, blocks, pipelineVersion: SPLIT_PIPELINE_VERSION };
};

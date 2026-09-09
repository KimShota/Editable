import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatAssetsDir } from "./paths";

/**
 * The canonical beat sheet for a `repeat`-block format — "what this
 * creator's video is ALWAYS made of," derived once from their own
 * published reference videos (tools/buildReferenceBeats.ts) and checked in
 * alongside the format.
 *
 * Without it, discover.ts judges every job's footage from scratch and
 * re-invents the running order each time; a creator whose format is
 * genuinely identical every episode gets a different edit every episode,
 * which is exactly the thing this product exists NOT to do. With it,
 * discovery becomes a MATCHING problem instead of an inventing one: each
 * candidate shot is asked "which of these known beats is this?", and the
 * final running order comes from the beat sheet rather than from wherever
 * the moment happened to sit in the raw file.
 *
 * Deliberately data, not code: a new creator/niche is another
 * referenceBeats.json next to another format file, never a change here.
 */

export const ReferenceBeatSchema = z.object({
  /** Stable slug, e.g. "wake" / "greeting" / "bath". */
  id: z.string(),
  /** Canonical position in the running order — the SORT KEY discover.ts
   *  orders its output by, which is what makes every episode open on the
   *  same beat regardless of when it was filmed. */
  order: z.number().int().min(0),
  /** Short human label for artifacts/logs, in the creator's own language. */
  label: z.string(),
  /** What this beat looks and sounds like, concretely enough for a model
   *  to recognize it in unseen footage — framing, action, typical words. */
  description: z.string(),
  /** Caption text actually observed on this beat in the reference videos —
   *  both the style guide and the fallback when a job's own footage
   *  supports no better wording. */
  captionExamples: z.array(z.string()).default([]),
  /** Clock time this beat usually carries, "H:MM" — a prior for
   *  discover.ts's own time estimate, never an override of a clock the
   *  model can actually read in frame. */
  typicalClockTime: z.string().optional(),
  /** False when the beat appears in every reference video — used only to
   *  tell the model which beats are load-bearing and which are episode
   *  colour, never to force a beat into footage that lacks it. */
  optional: z.boolean().default(true),
  /** The opening hook that carries the title card. Exactly one beat in a
   *  sheet should set this. */
  isTitleBeat: z.boolean().default(false),
  /** Playback rate for this beat (see BlockSchema's own `speed`) — set
   *  above 1 for a beat whose point is that it took a long time, which
   *  the reference edit compresses into a couple of seconds of sped-up
   *  footage under a time-RANGE caption ("10:30〜11:30 eFootball練習する")
   *  rather than showing a slice of it at real speed. */
  speed: z.number().positive().default(1),
  /** This beat is part of a fixed opening sequence that is filmed and cut
   *  the same way in EVERY episode — not just "usually present" like an
   *  ordinary `optional: false` beat, but literally the same shots in the
   *  same order every time (e.g. this creator's wake-up → greeting →
   *  product-catch → eat/drink routine). A pinned beat's running-order
   *  position comes from its own `order` rather than where it happened to
   *  sit in the source file (see discover.ts's sort), and it is exempt
   *  from the too-short/lowest-importance drop passes — a beat that is
   *  ALWAYS there should never be the one that gets cut for length. */
  pinned: z.boolean().default(false),
  /** Forces this beat's rendered clock-time overlay to a literal value
   *  (or "" for no time shown at all — e.g. a reaction beat with no clock
   *  in the reference episodes), rather than letting the model read one
   *  off frame. Only meaningful when the value the beat carries genuinely
   *  never varies — for anything the model reads correctly from footage
   *  (a smart-speaker clock, an on-screen timer), leave this unset. */
  fixedClockTime: z.string().optional(),
  /** Forces this beat's caption text to a literal value, for a beat whose
   *  spoken line is scripted and identical every episode (e.g. "起床",
   *  "おいしー!"). Leave unset for a beat whose content genuinely varies
   *  episode to episode (a product name, a place, a meal) — the model's
   *  own caption, matched to this beat's captionExamples above, still
   *  applies. */
  fixedCaption: z.string().optional(),
  /** Per-beat span budget (finished/timeline seconds, before `speed`),
   *  overriding the format's own discovery.minBeatSec/maxBeatSec for just
   *  this beat — for a beat measurably shorter or longer than the format
   *  average every time (a half-second product catch; a two-second
   *  greeting). Unset falls back to the format-wide bounds, same as
   *  today. */
  minSec: z.number().positive().optional(),
  maxSec: z.number().positive().optional(),
  /**
   * Hand-cut EXAMPLES of this beat done right — the creator trimming the
   * moment themselves out of their own raw footage, checked in next to
   * the format. Prose can say "pick the good part of the wake-up"; it
   * cannot convey that the good part starts once he is upright and ends
   * on the thumbs-up. A few frames of a correct cut can, so discover.ts
   * attaches them to its own prompt alongside the candidate shots.
   *
   * This is the cheapest correction loop the system has: when a beat
   * comes out wrong, the creator cuts a few seconds of it by hand, runs
   * `npm run reference:exemplar`, and every future episode is judged
   * against that example. More than one is allowed and useful for a beat
   * whose CONTENT varies but whose cutting style doesn't — the day's main
   * outing is a different place every episode, so two examples teach the
   * rhythm rather than the subject. See tools/registerExemplar.ts.
   */
  exemplars: z
    .array(
      z.object({
        /** Video file, relative to formats/assets/<formatId>/. */
        clip: z.string(),
        /** Whole length of the hand-cut example. */
        durationSec: z.number().positive().optional(),
        /** How many cuts it is made of — a beat is often two quick shots
         *  (the coffee, then the selfie), so durationSec alone would
         *  overstate how long ONE cut of this beat should run. */
        shotCount: z.number().int().positive().default(1),
        /** What makes this cut right, and the near-miss it is NOT (the
         *  mistake this exemplar was registered to correct). */
        rule: z.string().optional(),
        /** Where in the creator's own raw footage this was cut from —
         *  provenance only, so a future reader can re-derive it. */
        sourceNote: z.string().optional(),
      }),
    )
    .default([]),
}).refine((b) => b.minSec === undefined || b.maxSec === undefined || b.maxSec >= b.minSec, {
  message: "maxSec must be >= minSec when both are set",
});

export const ReferenceBeatSheetSchema = z.object({
  formatId: z.string(),
  /** Which reference videos this sheet was derived from — provenance, so a
   *  regenerated sheet is diffable against what it was built from. */
  sources: z.array(z.string()).default([]),
  /** Typical finished length across the reference videos, seconds. */
  typicalTotalSec: z.number().positive().optional(),
  /** Free-text provenance note for a sheet that isn't (or isn't purely) a
   *  `reference:beats` regeneration — e.g. a hand-authored `pinned` split
   *  of an opening sequence that should NOT be overwritten by re-running
   *  that tool. Read by nobody except a future human; discover.ts ignores
   *  it. */
  notes: z.string().optional(),
  beats: z.array(ReferenceBeatSchema).min(1),
});

export type ReferenceBeat = z.infer<typeof ReferenceBeatSchema>;
export type ReferenceBeatSheet = z.infer<typeof ReferenceBeatSheetSchema>;

export const referenceBeatsPath = (formatId: string): string =>
  path.join(formatAssetsDir(formatId), "referenceBeats.json");

/** The format's own beat sheet, or null when it ships none (discovery then
 *  falls back to judging the footage from scratch — see discover.ts). A
 *  malformed sheet throws rather than silently degrading: it's checked-in
 *  authored data, so a parse failure is a packaging bug worth failing on,
 *  not a missing optional input. */
export const loadReferenceBeats = (formatId: string): ReferenceBeatSheet | null => {
  const file = referenceBeatsPath(formatId);
  if (!fs.existsSync(file)) return null;
  const parsed = ReferenceBeatSheetSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`referenceBeats for format "${formatId}" failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

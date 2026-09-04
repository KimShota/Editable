import { FormatSchema } from "./schemas";
import { Block, Format } from "./types";

/**
 * Module 0.5 — Format expansion.
 *
 * A `repeat: true` block (see BlockSchema's own doc comment) is a
 * TEMPLATE: the format author writes it once, describing what one "beat"
 * of the source footage looks like, and discover.ts finds however many of
 * them actually occur in a given job's own footage. expandFormat turns
 * that template plus discover.ts's own findings into an ordinary,
 * fixed-block Format — cloning the template block once per beat, renaming
 * ids/slots so each clone is independently addressable, and substituting
 * `{{field}}` tokens in the clone's own event params with that beat's own
 * discovered text (clockTime, caption, …).
 *
 * Everything downstream of this — intake's second pass, transcribe/trim,
 * resolveRoles, assemble, the editor — sees only the EXPANDED format and
 * needs no changes of its own: exactly the same "format config vs. fixed
 * engine" split every other format-specific behavior already uses, just
 * with the config now generated per-job instead of hand-authored once.
 */

/** One beat discover.ts found in the bound speakingTakeSlot, already
 *  cleaned up (snapped to speech, clamped, ordered, deduped, merged) —
 *  the shared shape both expandFormat and discover.ts's own
 *  discoverResultToSplitTake consume, each reading only their own half of
 *  it. `fields` carries whatever text discover.ts generated for this
 *  beat, keyed by the token name a template event's own params reference
 *  as `"{{clockTime}}"` etc — the only part expandFormat itself reads.
 *  `segments` is where this beat's footage actually lives in the source
 *  take (usually one span; two when discover.ts judged a line to
 *  continue across a take boundary and merged it in) — expandFormat never
 *  touches this; it exists purely for discoverResultToSplitTake to turn
 *  into an ordinary splitTake.json, keyed by the SAME beatBlockId(index)
 *  this module exports so the two stay in lockstep by construction. */
export type DiscoverBeat = {
  fields: Record<string, string>;
  segments: { srcInSec: number; srcOutSec: number; confidence: number }[];
  /** Playback rate for this beat, from its reference beat's own `speed`
   *  (see referenceBeats.ts). Undefined means real time. */
  speed?: number;
};

const PAD = 2;

/** Deterministic clone id for the Nth (0-based) beat of a `repeat`
 *  template block — shared with discover.ts so the splitTake.json it
 *  writes directly (see its own doc comment) names the same blockIds
 *  expandFormat is about to create. */
export const beatBlockId = (templateId: string, index: number): string =>
  `${templateId}-${String(index + 1).padStart(PAD, "0")}`;

const TOKEN_RE = /\{\{(\w+)\}\}/g;

/** Replaces every `{{field}}` occurrence found anywhere inside a value —
 *  recursing through arrays/objects — with `tokens[field]`, leaving an
 *  unknown token's `{{...}}` text untouched (fails visibly in the
 *  rendered output rather than silently swallowing a typo). */
const substituteTokens = (value: unknown, tokens: Record<string, string>): unknown => {
  if (typeof value === "string") {
    return value.replace(TOKEN_RE, (whole, key: string) => (key in tokens ? tokens[key] : whole));
  }
  if (Array.isArray(value)) return value.map((v) => substituteTokens(v, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteTokens(v, tokens)]),
    );
  }
  return value;
};

const cloneBlockForBeat = (template: Block, index: number, isFirst: boolean, isLast: boolean, beat: DiscoverBeat): Block => {
  const speed = beat.speed ?? template.speed;
  const id = beatBlockId(template.id, index);
  const videoSlot = `${id}-clip`;
  const slots = template.slots.map((s) =>
    s.name === template.videoSlot ? { ...s, name: videoSlot } : { ...s, name: `${id}-${s.name}` },
  );
  const events = template.events
    .filter((e) => (e.repeatScope === "first" ? isFirst : e.repeatScope === "last" ? isLast : true))
    .map((e) => ({
      ...e,
      id: `${id}-${e.id}`,
      component: { ...e.component, params: substituteTokens(e.component.params, beat.fields) as Record<string, unknown> },
    }));
  return { ...template, id, title: `${template.title} ${index + 1}`, repeat: false, speed, videoSlot, slots, events };
};

export const hasRepeatBlock = (format: Format): boolean => format.blocks.some((b) => b.repeat);

/**
 * Expands `format`'s own `repeat` block into one clone per entry in
 * `beats` (already in final playback order). A format with no `repeat`
 * block is returned unchanged (FormatSchema's own superRefine caps a
 * format at one `repeat` block, so there is never more than one template
 * to expand). Re-validates the result against FormatSchema so a naming
 * bug here fails loudly at expand time, not three stages later against an
 * unrelated error.
 */
export const expandFormat = (format: Format, beats: DiscoverBeat[]): Format => {
  const templateIndex = format.blocks.findIndex((b) => b.repeat);
  if (templateIndex === -1) return format;
  if (beats.length === 0) {
    throw new Error(
      `expandFormat: discovery found zero usable beats for format "${format.id}" — nothing to build. ` +
        "The source footage may be too short, silent, or unclear for automatic discovery.",
    );
  }
  const template = format.blocks[templateIndex];
  const cloned = beats.map((beat, i) => cloneBlockForBeat(template, i, i === 0, i === beats.length - 1, beat));
  const blocks = [...format.blocks.slice(0, templateIndex), ...cloned, ...format.blocks.slice(templateIndex + 1)];
  return FormatSchema.parse({ ...format, blocks });
};

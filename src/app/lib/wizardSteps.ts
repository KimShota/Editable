import type { Format } from "@backend/pipeline/types";

/**
 * Whether the resources wizard's step 1 ("Write your script") has anything
 * to ask this format for.
 *
 * That step renders exactly two things: a spoken line per non-optional
 * voice block, and a field per text slot. A `repeat` block supplies
 * neither — it's a TEMPLATE that discover.ts clones once per beat it finds
 * in the day's footage, deriving both the spoken line and the on-screen
 * text from that footage (see discover.ts / expandFormat.ts). A format
 * built entirely out of one therefore has nothing to write, and showing
 * the step anyway leaves the user staring at a single empty box that
 * changes nothing about the video.
 *
 * Lives here rather than inside ResourcesBoard because the page's own
 * header sentence ("Three steps: …") has to agree with the wizard about
 * how many steps there are, and that header is a server component.
 */
export const formatHasScriptStep = (format: Format): boolean =>
  format.blocks.some(
    (b) => !b.optional && (b.slots.some((s) => s.mediaType === "text") || (b.kind === "voice" && !b.repeat)),
  );

/**
 * Whether this format finds its own cuts at build time instead of aligning
 * the take against a fixed block list.
 *
 * A `repeat` block means discover.ts does the splitting: it watches the
 * footage, decides how many beats are in it, and writes splitTake.json
 * itself (see discover.ts's discoverResultToSplitTake). The wizard's
 * "Split your take into lines" panel is the OTHER path — splitTake.ts
 * walking a known, hand-authored sequence of lines — and running it here
 * would transcribe the whole take just to align it against the single
 * unexpanded template block, producing one span covering the entire file,
 * keyed to a blockId ("beat") that no longer exists once the format is
 * expanded into beat-01..beat-NN.
 */
export const formatDiscoversItsOwnCuts = (format: Format): boolean => format.blocks.some((b) => b.repeat);

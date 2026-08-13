import { ARCHIVO_BLACK_STACK, FONT_FAMILY_SHORTHANDS, MONTSERRAT_ITALIC_STACK, PLAYFAIR_DISPLAY_STACK, POPPINS_STACK, SYSTEM_FONT } from "./style";

/**
 * Framework-free text-fit approximation shared by the assemble-time
 * text-overlay auto-layout solver (pipeline/textOverlayLayout.ts — plain
 * Node, no DOM/canvas available) and TextOverlay.tsx's own render-time
 * containment (the outer inset it applies around its content). Same "good
 * enough, not exact" approach as this file's neighbor style.ts's own
 * fitDidoneFontSize, generalized to per-family width factors and real
 * multi-line wrapping instead of one width-fit number.
 *
 * Every estimate here is deliberately biased slightly WIDE (overestimates
 * average glyph width, underestimates how much fits on a line) — the
 * solver's whole job is preventing overlap, so wrapping one word early or
 * shrinking one step further than strictly necessary is the safe direction
 * to be wrong in. TextOverlay.tsx's own `overflow: hidden` (see its doc
 * comment) is the hard backstop if this estimate is ever still off.
 */

/** Average glyph advance width as a fraction of font size, for ordinary
 *  mixed-case running text (includes spaces) — eyeballed per face, rounded
 *  up. Keyed by the CSS stack (post FONT_FAMILY_SHORTHANDS resolution) so
 *  a raw stack an event authors directly, not one of the five shorthands,
 *  still resolves via DEFAULT_CHAR_WIDTH_FACTOR below instead of throwing. */
const CHAR_WIDTH_FACTOR_BY_STACK: Record<string, number> = {
  [SYSTEM_FONT]: 0.56,
  [POPPINS_STACK]: 0.58,
  [PLAYFAIR_DISPLAY_STACK]: 0.62,
  [ARCHIVO_BLACK_STACK]: 0.66,
  [MONTSERRAT_ITALIC_STACK]: 0.62,
};
const DEFAULT_CHAR_WIDTH_FACTOR = 0.58;

export const charWidthFactor = (fontFamily: string | undefined): number => {
  const stack = fontFamily ? (FONT_FAMILY_SHORTHANDS[fontFamily] ?? fontFamily) : SYSTEM_FONT;
  return CHAR_WIDTH_FACTOR_BY_STACK[stack] ?? DEFAULT_CHAR_WIDTH_FACTOR;
};

const estimateRunWidthPx = (run: string, fontSizePx: number, factor: number): number => run.length * fontSizePx * factor;

/** Greedy word-wrap within `maxWidthPx`, honoring an authored "\n" as a
 *  hard break (TextOverlay renders with `white-space: pre-line`, and the
 *  CTA slot's own instructions ask authors to write one phrase per line).
 *  An overlong single word still gets its own (overflowing) line rather
 *  than being split mid-word — matches the real CSS, which never sets
 *  `overflow-wrap: anywhere`. */
export const wrapTextEstimate = (text: string, fontSizePx: number, maxWidthPx: number, fontFamily: string | undefined): string[] => {
  const factor = charWidthFactor(fontFamily);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (estimateRunWidthPx(candidate, fontSizePx, factor) <= maxWidthPx) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
};

/** The wrapped block's total height at `fontSizePx` within `maxWidthPx` —
 *  what the auto-layout solver grows/shrinks an overlay's box around. */
export const estimateBlockHeightPx = (
  text: string,
  fontSizePx: number,
  maxWidthPx: number,
  fontFamily: string | undefined,
  lineHeightMultiplier: number,
): number => wrapTextEstimate(text, fontSizePx, maxWidthPx, fontFamily).length * fontSizePx * lineHeightMultiplier;

/** The inset TextOverlay.tsx's outer AbsoluteFill applies around its
 *  content when it has no background pill — proportional to the box's own
 *  smaller dimension instead of a fixed pixel value, so it stays sane on a
 *  small per-event box (e.g. a resource card's ~150px-tall title region)
 *  instead of eating most of it, which is what a flat 60px inset used to
 *  do (fine when every TextOverlay was full-frame; wrong the moment boxes
 *  became small and per-event). Shared by the solver, which needs to
 *  predict it, and the component, which applies it — one function instead
 *  of two hand-copied numbers drifting apart. */
export const outerInsetPx = (boxWidthPx: number, boxHeightPx: number): number =>
  Math.max(10, Math.min(60, Math.min(boxWidthPx, boxHeightPx) * 0.08));

/** Clamps a background-pill's own paddingX/paddingY (see TextOverlay.tsx's
 *  props) so a format's authored value — or a future hand-edited one —
 *  can never itself swallow a small box the way outerInsetPx's old fixed
 *  60px did. Authored values well inside this bound (the common case)
 *  pass through unchanged. */
export const clampPillPadding = (paddingPx: number, boxDimensionPx: number): number =>
  Math.max(0, Math.min(paddingPx, boxDimensionPx * 0.24));

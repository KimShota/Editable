import { ARCHIVO_BLACK_STACK, FONT_FAMILY_SHORTHANDS, MONTSERRAT_ITALIC_STACK, PLAYFAIR_DISPLAY_STACK, POPPINS_STACK, SYSTEM_FONT } from "./style";
import { isCjkChar } from "./cjk";

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

/** A CJK glyph is roughly square (full-width), much wider than a Latin
 *  lowercase average — used per-character instead of `charWidthFactor`'s
 *  per-run Latin estimate whenever a unit (see splitIntoUnits) is CJK. */
const CJK_CHAR_WIDTH_FACTOR = 1.0;

export const charWidthFactor = (fontFamily: string | undefined): number => {
  const stack = fontFamily ? (FONT_FAMILY_SHORTHANDS[fontFamily] ?? fontFamily) : SYSTEM_FONT;
  return CHAR_WIDTH_FACTOR_BY_STACK[stack] ?? DEFAULT_CHAR_WIDTH_FACTOR;
};

const estimateUnitWidthPx = (unit: string, fontSizePx: number, factor: number): number =>
  isCjkChar(unit) ? fontSizePx * CJK_CHAR_WIDTH_FACTOR : unit.length * fontSizePx * factor;

/** Breakable units for wrapping, WITH original spacing preserved (unlike
 *  cjk.ts's own splitIntoUnits, which throws whitespace away — fine for
 *  finding a title's split point, wrong here since these units get
 *  reassembled into the literal rendered caption text). An ordinary Latin
 *  word keeps its own trailing space (if any) glued on, so two adjacent
 *  word units always came from real whitespace in the source and
 *  concatenating them back reproduces it exactly; each CJK character is
 *  still its own unit (Japanese/Chinese text can break between any two of
 *  them), with any space that happened to follow it (rare — CJK text is
 *  not normally space-separated) appended onto it directly, since there's
 *  no separate word unit to carry that trailing space instead. */
const unitsWithSpacing = (text: string): string[] => {
  const units: string[] = [];
  let current = "";
  for (const ch of Array.from(text)) {
    if (isCjkChar(ch)) {
      if (current) {
        units.push(current);
        current = "";
      }
      units.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        units.push(`${current} `);
        current = "";
      } else if (units.length > 0 && !units[units.length - 1].endsWith(" ")) {
        units[units.length - 1] += " ";
      }
      continue;
    }
    current += ch;
  }
  if (current) units.push(current);
  return units;
};

/** Greedy wrap within `maxWidthPx`, honoring an authored "\n" as a hard
 *  break (TextOverlay renders with `white-space: pre-line`, and the CTA
 *  slot's own instructions ask authors to write one phrase per line). An
 *  ordinary Latin word may still overflow its own line rather than split
 *  mid-word — matches the real CSS, which never sets
 *  `overflow-wrap: anywhere` — while Japanese/Chinese text (no spaces, see
 *  unitsWithSpacing) can break between any two characters. */
export const wrapTextEstimate = (text: string, fontSizePx: number, maxWidthPx: number, fontFamily: string | undefined): string[] => {
  const factor = charWidthFactor(fontFamily);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const units = unitsWithSpacing(paragraph);
    if (units.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidthPx = 0;
    for (const unit of units) {
      const unitWidthPx = estimateUnitWidthPx(unit, fontSizePx, factor);
      if (current && currentWidthPx + unitWidthPx > maxWidthPx) {
        lines.push(current.trimEnd());
        current = unit;
        currentWidthPx = unitWidthPx;
      } else {
        current += unit;
        currentWidthPx += unitWidthPx;
      }
    }
    lines.push(current.trimEnd());
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

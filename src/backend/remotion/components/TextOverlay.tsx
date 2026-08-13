import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  FONT_FAMILY_SHORTHANDS,
  KUMAR_RED,
  PLAYFAIR_DISPLAY_STACK,
  SYSTEM_FONT,
  TEXT_SHADOW,
  TEXT_VARIANTS,
  TextVariant,
  fitDidoneFontSize,
} from "../../components/style";
import { clampPillPadding, outerInsetPx } from "../../components/textFit";
import { ensureDisplayFonts } from "../fonts";

/**
 * The one text component every format shares. A format config picks a
 * `variant` (and optionally overrides size); the variants encode the
 * house styles ported from the original hand-built blocks — see
 * TEXT_VARIANTS in components/style.ts (framework-free, shared with the
 * editor's Inspector/OverlayCanvas so an unedited event's effective style
 * is never a hand-copied number on either side).
 *
 * "kumarSplitTitle" is a special case with its own render path below
 * (not in TEXT_VARIANTS): the reference end card doesn't center its title
 * as one block — it splits across the top and bottom of frame with the
 * subject's own full-body shot showing between the two halves.
 */

type Variant = TextVariant;

/** Splits `text` into two lines at the word boundary closest to the
 *  midpoint by character count — "SHOTA'S DEBUT" -> ["SHOTA'S", "DEBUT"],
 *  degrading sensibly for arbitrary title text. Single-word text (nothing
 *  to split) renders whole on the top line, no bottom line. */
const splitTitleLines = (text: string): [string, string] => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text.trim(), ""];
  let bestIdx = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return [words.slice(0, bestIdx).join(" "), words.slice(bestIdx).join(" ")];
};

/** The reference end card's own layout: title split top/bottom of frame
 *  with the subject's full-body shot showing between the two halves,
 *  instead of one centered block sitting on top of them. */
const KumarSplitTitle: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  ensureDisplayFonts();
  const progress = spring({ frame, fps, config: { damping: 12, stiffness: 200 } });
  const scale = interpolate(progress, [0, 1], [1.35, 1]);
  const [top, bottom] = splitTitleLines(text);

  const lineStyle = (line: string): React.CSSProperties => ({
    fontFamily: PLAYFAIR_DISPLAY_STACK,
    fontWeight: 900,
    fontSize: fitDidoneFontSize(line, width, height),
    lineHeight: 1.1,
    color: KUMAR_RED,
    textAlign: "center",
    textShadow: TEXT_SHADOW,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6% 24px",
        opacity: progress,
        transform: `scale(${scale})`,
      }}
    >
      <div style={lineStyle(top)}>{top}</div>
      {bottom && <div style={lineStyle(bottom)}>{bottom}</div>}
    </AbsoluteFill>
  );
};

export const TextOverlay: React.FC<{
  text?: string;
  variant?: string;
  fontSize?: number;
  /** Per-event override of the variant's default typography — a
   *  shorthand key (see FONT_FAMILY_SHORTHANDS) or a raw CSS stack.
   *  Lets one format opt into different type (e.g. Poppins for a
   *  geometric-sans reference) without changing the shared variant
   *  default every other format's TextOverlay events still render with. */
  fontFamily?: string;
  color?: string;
  fontWeight?: number;
  italic?: boolean;
  underline?: boolean;
  /** Overrides the variant's own casing (kumarTitle always uppercases
   *  otherwise) — "none" keeps the text exactly as authored/typed. */
  textCase?: "upper" | "lower" | "none";
  /** When set, renders the text as a padded, rounded card behind it (the
   *  reference reel's white resource-title/description pills) instead of
   *  bare drop-shadowed text. A CSS color; the box hugs the text content
   *  (inline-block) rather than needing a hand-measured fixed size. */
  background?: string;
  backgroundRadius?: number;
  paddingX?: number;
  paddingY?: number;
  /** This event's own on-canvas box, in composition px — set by
   *  EdlVideo.tsx's OverlayInstance from the EDL's x/y/width/height
   *  fraction (see EdlOverlaySchema). Used only to keep the outer inset
   *  and the background pill's own padding proportional to a SMALL box
   *  (see outerInsetPx's doc comment) instead of the flat 60px that used
   *  to swallow most of a ~150px-tall resource-card title region. Falls
   *  back to the full frame when absent (a standalone/full-frame render). */
  boxWidthPx?: number;
  boxHeightPx?: number;
}> = ({
  text = "",
  variant = "hook",
  fontSize,
  fontFamily,
  color,
  fontWeight,
  italic,
  underline,
  textCase,
  background,
  backgroundRadius = 28,
  paddingX = 40,
  paddingY = 22,
  boxWidthPx,
  boxHeightPx,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (variant === "kumarSplitTitle") return <KumarSplitTitle text={text} />;
  const style = TEXT_VARIANTS[(variant as Variant) in TEXT_VARIANTS ? (variant as Variant) : "hook"];
  const resolvedFontFamily = fontFamily ? (FONT_FAMILY_SHORTHANDS[fontFamily] ?? fontFamily) : style.fontFamily;
  if (resolvedFontFamily && resolvedFontFamily !== SYSTEM_FONT) ensureDisplayFonts();

  const boxWpx = boxWidthPx ?? width;
  const boxHpx = boxHeightPx ?? height;
  // A background pill contains itself via its own padding below; the
  // outer inset is only for bare (no-pill) text, so the two never stack
  // and double-eat a small box's own height (see textOverlayLayout.ts's
  // computeInsets, which this mirrors exactly — the solver has to predict
  // the same number this renders with).
  const outerPad = background ? 0 : outerInsetPx(boxWpx, boxHpx);
  const resolvedPaddingX = background ? clampPillPadding(paddingX, boxWpx) : paddingX;
  const resolvedPaddingY = background ? clampPillPadding(paddingY, boxHpx) : paddingY;

  // The resolve/kumarTitle punch in on the beat; everything else eases in
  // quickly.
  const isPunch = variant === "resolve" || variant === "kumarTitle";
  const progress = isPunch
    ? spring({ frame, fps, config: { damping: 12, stiffness: 200 } })
    : interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  const scale = isPunch ? interpolate(progress, [0, 1], [1.35, 1]) : 1;
  const textTransform = textCase === "upper" ? "uppercase" : textCase === "lower" ? "lowercase" : textCase === "none" ? "none" : style.uppercase ? "uppercase" : undefined;

  return (
    <AbsoluteFill
      // overflow: hidden is the hard backstop: whatever the auto-layout
      // solver estimated (textOverlayLayout.ts, Node-side, no real glyph
      // metrics available there — see textFit.ts's own doc comment on why
      // it's an approximation), this box never visually spills into
      // whatever sits next to it. Worst case on a misjudged estimate is
      // an invisibly clipped line, not a collision.
      style={{ justifyContent: "center", alignItems: "center", padding: outerPad, overflow: "hidden" }}
    >
      <div
        style={{
          fontFamily: resolvedFontFamily ?? SYSTEM_FONT,
          fontWeight: fontWeight ?? style.fontWeight,
          fontStyle: italic ? "italic" : undefined,
          textDecoration: underline ? "underline" : undefined,
          fontSize: fontSize ?? style.fontSize,
          lineHeight: 1.15,
          color: color ?? style.color,
          textAlign: "center",
          textShadow: background ? "none" : TEXT_SHADOW,
          textTransform,
          whiteSpace: "pre-line",
          opacity: progress,
          transform: `scale(${scale})`,
          ...(background
            ? {
                display: "inline-block",
                background,
                borderRadius: backgroundRadius,
                padding: `${resolvedPaddingY}px ${resolvedPaddingX}px`,
                boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              }
            : {}),
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

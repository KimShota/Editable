import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, SYSTEM_FONT, TEXT_SHADOW, fitDidoneFontSize } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * The one text component every format shares. A format config picks a
 * `variant` (and optionally overrides size); the variants encode the
 * house styles ported from the original hand-built blocks.
 *
 * "kumarSplitTitle" is a special case with its own render path below
 * (not in VARIANTS): the reference end card doesn't center its title as
 * one block — it splits across the top and bottom of frame with the
 * subject's own full-body shot showing between the two halves.
 */

type Variant = "hook" | "resolve" | "title" | "description" | "cta" | "kumarTitle";

const VARIANTS: Record<
  Variant,
  { fontSize: number; fontWeight: number; color: string; offsetY: number; fontFamily?: string; uppercase?: boolean }
> = {
  hook: { fontSize: 86, fontWeight: 800, color: "white", offsetY: 0 },
  resolve: { fontSize: 120, fontWeight: 900, color: "white", offsetY: 0 },
  title: { fontSize: 64, fontWeight: 800, color: "white", offsetY: -60 },
  description: {
    fontSize: 40,
    fontWeight: 500,
    color: "rgba(255,255,255,0.92)",
    offsetY: 40,
  },
  cta: { fontSize: 60, fontWeight: 800, color: "white", offsetY: 0 },
  // The "KUMAR'S DEBUT" / big-word look: a Didone serif in the reference
  // reel's red, always caps regardless of the source text's own casing.
  kumarTitle: {
    fontSize: 96,
    fontWeight: 900,
    color: KUMAR_RED,
    offsetY: 0,
    fontFamily: PLAYFAIR_DISPLAY_STACK,
    uppercase: true,
  },
};

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
}> = ({ text = "", variant = "hook", fontSize }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (variant === "kumarSplitTitle") return <KumarSplitTitle text={text} />;
  const style = VARIANTS[(variant as Variant) in VARIANTS ? (variant as Variant) : "hook"];
  if (style.fontFamily) ensureDisplayFonts();

  // The resolve/kumarTitle punch in on the beat; everything else eases in
  // quickly.
  const isPunch = variant === "resolve" || variant === "kumarTitle";
  const progress = isPunch
    ? spring({ frame, fps, config: { damping: 12, stiffness: 200 } })
    : interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  const scale = isPunch ? interpolate(progress, [0, 1], [1.35, 1]) : 1;

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 60 }}
    >
      <div
        style={{
          fontFamily: style.fontFamily ?? SYSTEM_FONT,
          fontWeight: style.fontWeight,
          fontSize: fontSize ?? style.fontSize,
          lineHeight: 1.15,
          color: style.color,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
          textTransform: style.uppercase ? "uppercase" : undefined,
          whiteSpace: "pre-line",
          opacity: progress,
          transform: `translateY(${style.offsetY}px) scale(${scale})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

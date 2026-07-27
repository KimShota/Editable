import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, SYSTEM_FONT, TEXT_SHADOW } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * The one text component every format shares. A format config picks a
 * `variant` (and optionally overrides size); the variants encode the
 * house styles ported from the original hand-built blocks.
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

export const TextOverlay: React.FC<{
  text?: string;
  variant?: string;
  fontSize?: number;
}> = ({ text = "", variant = "hook", fontSize }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
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

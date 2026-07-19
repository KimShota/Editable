import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SYSTEM_FONT, TEXT_SHADOW } from "../../components/style";

/**
 * The one text component every format shares. A format config picks a
 * `variant` (and optionally overrides size); the variants encode the
 * house styles ported from the original hand-built blocks.
 */

type Variant = "hook" | "resolve" | "title" | "description" | "cta";

const VARIANTS: Record<
  Variant,
  { fontSize: number; fontWeight: number; color: string; offsetY: number }
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
};

export const TextOverlay: React.FC<{
  text?: string;
  variant?: string;
  fontSize?: number;
}> = ({ text = "", variant = "hook", fontSize }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = VARIANTS[(variant as Variant) in VARIANTS ? (variant as Variant) : "hook"];

  // The resolve punches in on the beat; everything else eases in quickly.
  const isPunch = variant === "resolve";
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
          fontFamily: SYSTEM_FONT,
          fontWeight: style.fontWeight,
          fontSize: fontSize ?? style.fontSize,
          lineHeight: 1.15,
          color: style.color,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
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

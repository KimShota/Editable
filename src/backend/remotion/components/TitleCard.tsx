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
 * A full-frame name card that punches in over the footage — the "5 SECRET
 * CHATGPT CODES" / "First is: [name]" beat. The text usually comes from a
 * literal anchor's capture (the user's own words), via the textAnchor
 * param resolved at assembly.
 */
export const TitleCard: React.FC<{ text?: string; fontSize?: number }> = ({
  text = "",
  fontSize = 96,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 13, stiffness: 220 } });
  const scale = interpolate(progress, [0, 1], [1.3, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 70,
        backgroundColor: `rgba(0,0,0,${interpolate(progress, [0, 1], [0, 0.55])})`,
      }}
    >
      <div
        style={{
          fontFamily: SYSTEM_FONT,
          fontWeight: 900,
          fontSize,
          lineHeight: 1.08,
          color: "white",
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: 2,
          textShadow: TEXT_SHADOW,
          whiteSpace: "pre-line",
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

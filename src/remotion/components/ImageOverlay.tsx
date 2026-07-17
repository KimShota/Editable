import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

/** A user-supplied image/meme popped over the footage (e.g. a punchline). */
export const ImageOverlay: React.FC<{ src?: string; widthPct?: number }> = ({
  src,
  widthPct = 70,
}) => {
  const frame = useCurrentFrame();
  if (!src) return null;
  const progress = interpolate(frame, [0, 5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Img
        src={staticFile(src)}
        style={{
          maxWidth: `${widthPct}%`,
          maxHeight: "60%",
          borderRadius: 24,
          opacity: progress,
          transform: `scale(${interpolate(progress, [0, 1], [0.85, 1])})`,
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      />
    </AbsoluteFill>
  );
};

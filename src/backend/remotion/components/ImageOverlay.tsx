import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Gif } from "@remotion/gif";

/**
 * A user-supplied image/meme popped over the footage (e.g. a punchline).
 * Animated gifs play in sync with the timeline via @remotion/gif.
 *
 * Fills its wrapper box entirely (see EdlVideo.tsx, which sizes/positions
 * that box from the overlay's own x/y/width/height) rather than applying
 * its own internal max-size/centering — the box itself already carries the
 * right size (assemble.ts fits it to the image's real aspect ratio by
 * default), and is what the editor's canvas lets the user drag/resize
 * directly, so this needs to trust it completely rather than shrinking
 * again inside it.
 */
export const ImageOverlay: React.FC<{ src?: string }> = ({ src }) => {
  const frame = useCurrentFrame();
  if (!src) return null;
  const progress = interpolate(frame, [0, 5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    borderRadius: 24,
    opacity: progress,
    transform: `scale(${interpolate(progress, [0, 1], [0.85, 1])})`,
    boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
  };

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {src.toLowerCase().endsWith(".gif") ? (
        <Gif src={staticFile(src)} fit="contain" style={style} />
      ) : (
        <Img src={staticFile(src)} style={{ ...style, objectFit: "contain" }} />
      )}
    </AbsoluteFill>
  );
};

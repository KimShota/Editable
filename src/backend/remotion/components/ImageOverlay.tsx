import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Gif } from "@remotion/gif";
import { SYSTEM_FONT, TEXT_SHADOW } from "../../components/style";

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
 *
 * `label`/`labelColor`/`blurred` exist to reproduce a reference reel's own
 * rank-card treatment (e.g. a "BAD"/"GOOD"/"GREAT" tag, blurred-placeholder
 * -> sharp reveal) — they're ordinary optional params, so a format that
 * doesn't author them renders identically to before. They're meant to be
 * driven by an event's `states[]` (see schemas.ts's FormatEventStateSchema
 * and EdlVideo.tsx's OverlayInstance), which patches them mid-lifetime
 * without remounting this component — hence `blurred` is a HARD CUT here
 * (no smooth ramp): a smooth ramp needs to know when the active state
 * began, which this component doesn't have; deferred to a v1.1 pass.
 */
export const ImageOverlay: React.FC<{
  src?: string;
  label?: string;
  labelColor?: string;
  blurred?: boolean;
}> = ({ src, label, labelColor, blurred }) => {
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
    filter: blurred ? "blur(22px)" : "none",
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {label && (
        <div
          style={{
            position: "absolute",
            top: -44,
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: SYSTEM_FONT,
            fontWeight: 800,
            fontSize: 30,
            color: labelColor ?? "#fff",
            textShadow: TEXT_SHADOW,
            opacity: progress,
          }}
        >
          {label}
        </div>
      )}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        {src.toLowerCase().endsWith(".gif") ? (
          <Gif src={staticFile(src)} fit="contain" style={style} />
        ) : (
          <Img src={staticFile(src)} style={{ ...style, objectFit: "contain" }} />
        )}
      </AbsoluteFill>
    </div>
  );
};

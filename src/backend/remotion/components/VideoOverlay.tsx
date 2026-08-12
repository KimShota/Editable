import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { previewProxySrc } from "../previewSrc";

/**
 * A concurrent footage overlay: a screen recording (or any clip) layered
 * ON TOP of the talking clip rather than replacing it — the voice track
 * underneath keeps playing, so the overlay itself is muted. Loops nothing;
 * if the recording is shorter than its window it holds its last frame.
 *
 * Fills its wrapper box entirely (see ImageOverlay.tsx for why — the box
 * itself already carries the right size/position and is what the editor's
 * canvas drags/resizes directly).
 *
 * `jobId`/`previewMode` are injected by EdlVideo's OverlayInstance (not
 * authored params) — same preview-proxy swap EdlVideo's own Segment/FgLayer
 * use, so this doesn't live-decode an original (often 4K) source in the
 * editor just because it happens to be an overlay instead of a main-track
 * segment.
 */
export const VideoOverlay: React.FC<{ src?: string; jobId?: string; previewMode?: boolean }> = ({
  src,
  jobId,
  previewMode,
}) => {
  const frame = useCurrentFrame();
  if (!src) return null;
  const resolvedSrc = previewMode && jobId ? previewProxySrc(jobId, src) : staticFile(src);
  const progress = interpolate(frame, [0, 5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 24,
          overflow: "hidden",
          opacity: progress,
          transform: `scale(${interpolate(progress, [0, 1], [0.9, 1])})`,
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      >
        <OffthreadVideo
          src={resolvedSrc}
          muted
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        />
      </div>
    </AbsoluteFill>
  );
};

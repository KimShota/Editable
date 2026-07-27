import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

/**
 * A hard-cut visual cutaway: full-frame, muted, no card styling (that's
 * VideoOverlay's job — a floating picture-in-picture over the talking
 * shot). A cutaway REPLACES what's visible for its window while the
 * block's own audio keeps playing underneath unbroken — the reference
 * reel's own edit rhythm (SILHOUETTE/ECU shots cut into the middle of a
 * spoken line on ~0.9s beats, never interrupting the voice). No default
 * box in assemble.ts's DEFAULT_MEDIA_BOX_MAX means this gets the
 * full-frame fallback automatically — deliberate, not an oversight.
 */
export const CutawayOverlay: React.FC<{ src?: string }> = ({ src }) => {
  if (!src) return null;
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile(src)}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    </AbsoluteFill>
  );
};

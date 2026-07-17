import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { EdlCaptionGroup } from "../../pipeline/types";
import { SYSTEM_FONT, TEXT_SHADOW } from "../../components/style";

/**
 * Word captions with active-word highlight, driven by the EDL's caption
 * groups (absolute times). One instance renders all groups; only the group
 * containing the current time is visible.
 */

const HIGHLIGHT = "#FFD400";

export const Captions: React.FC<{
  groups: EdlCaptionGroup[];
  position?: string;
}> = ({ groups, position = "lowerThird" }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const tSec = frame / fps;

  const active = groups.find((g) => tSec >= g.tlInSec && tSec < g.tlOutSec);
  if (!active) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: position === "center" ? "center" : "flex-end",
        alignItems: "center",
        paddingBottom: position === "center" ? 0 : height * 0.24,
        paddingLeft: 48,
        paddingRight: 48,
      }}
    >
      <div style={{ textAlign: "center" }}>
        {active.words.map((w, i) => {
          const isActive = tSec >= w.tlStartSec && tSec < w.tlEndSec;
          return (
            <span
              key={i}
              style={{
                fontFamily: SYSTEM_FONT,
                fontWeight: 800,
                fontSize: 52,
                color: isActive ? HIGHLIGHT : "white",
                textShadow: TEXT_SHADOW,
                display: "inline-block",
                transform: isActive ? "scale(1.08)" : "scale(1)",
                margin: "0 8px",
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

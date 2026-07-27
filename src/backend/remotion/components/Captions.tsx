import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { EdlCaptionGroup } from "../../pipeline/types";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, SYSTEM_FONT, TEXT_SHADOW } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * Word captions driven by the EDL's caption groups (absolute times). One
 * instance renders all groups; only the group containing the current time
 * is visible. Each group carries its own `variant` (see schemas.ts's
 * EdlCaptionGroupSchema doc comment) and is rendered accordingly — a
 * single format can mix both (this one does: "lowerThird" for the opening
 * line, "bigTitle" for the anchor blocks that follow).
 *
 * lowerThird: the ordinary multi-word caption line, active-word
 * highlighted. The strong color pop is reserved for the currently-active
 * word ONLY when it's also flagged `emphasis` (a captured keyword — see
 * assemble.ts) — otherwise every merely-active function word ("the",
 * "is", "by") would get the same pop a real keyword does, which is the
 * karaoke-not-keyword problem this was built to fix. `theme: "kumar"`
 * switches to the reference reel's look: every word solid red/bold all
 * the time, no per-word highlight pop.
 *
 * bigTitle: word-level karaoke — assemble.ts gives each bigTitle group
 * exactly one word, so there's no "find the active word within the
 * group" step; the group's own single word IS the card, full-screen, in
 * the format's Didone-serif kumarTitle look, with a punch-in on entry.
 */

const HIGHLIGHT = "#FFD400";

const BigTitleCard: React.FC<{ group: EdlCaptionGroup }> = ({ group }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  ensureDisplayFonts();

  const localFrame = frame - Math.round(group.tlInSec * fps);
  const progress = spring({ frame: localFrame, fps, config: { damping: 12, stiffness: 200 } });
  const scale = interpolate(progress, [0, 1], [1.35, 1]);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 60 }}>
      <div
        style={{
          fontFamily: PLAYFAIR_DISPLAY_STACK,
          fontWeight: 900,
          fontSize: 96,
          lineHeight: 1.15,
          color: KUMAR_RED,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
          textTransform: "uppercase",
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        {group.words[0].text}
      </div>
    </AbsoluteFill>
  );
};

const LowerThirdLine: React.FC<{ group: EdlCaptionGroup; position: string; isKumar: boolean }> = ({
  group,
  position,
  isKumar,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const tSec = frame / fps;

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
        {group.words.map((w, i) => {
          const isActive = tSec >= w.tlStartSec && tSec < w.tlEndSec;
          const isKeywordHit = isActive && w.emphasis;
          return (
            <span
              key={i}
              style={{
                fontFamily: SYSTEM_FONT,
                fontWeight: 800,
                fontSize: 52,
                color: isKumar ? KUMAR_RED : isKeywordHit ? HIGHLIGHT : "white",
                textShadow: TEXT_SHADOW,
                display: "inline-block",
                transform: isKeywordHit ? "scale(1.08)" : isActive ? "scale(1.03)" : "scale(1)",
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

export const Captions: React.FC<{
  groups: EdlCaptionGroup[];
  position?: string;
  theme?: string;
}> = ({ groups, position = "lowerThird", theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tSec = frame / fps;

  const active = groups.find((g) => tSec >= g.tlInSec && tSec < g.tlOutSec);
  if (!active) return null;

  if (active.variant === "bigTitle") return <BigTitleCard group={active} />;
  return <LowerThirdLine group={active} position={position} isKumar={theme === "kumar"} />;
};

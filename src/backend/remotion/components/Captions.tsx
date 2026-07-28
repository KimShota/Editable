import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { EdlCaptionGroup } from "../../pipeline/types";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, SYSTEM_FONT, TEXT_SHADOW, fitDidoneFontSize } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * Word captions driven by the EDL's caption groups (absolute times). One
 * instance renders all groups; the active lowerThird group AND the active
 * bigTitle group are found INDEPENDENTLY and rendered TOGETHER when both
 * are live — the reference reel shows its lower-third line and its
 * full-screen keyword card at the same time, not one replacing the other
 * (assemble.ts now builds bigTitle groups as an ADDITIVE overlay on top
 * of full lowerThird coverage, not a substitute for it — see
 * BlockSchema's captionVariant doc comment).
 *
 * Each group carries its own `theme` (falling back to the `theme` prop,
 * the format's own captionStyle default) — "kumar": every word solid
 * red/bold, no per-word pop. "outroYellow": a casual yellow lower-third
 * (a block that deliberately breaks the cinematic tone — see
 * BlockSchema's captionTheme doc comment) — lower-third only, no
 * bigTitle look implied. Anything else: a neutral white line with a
 * yellow pop on the active emphasized word.
 *
 * lowerThird: the ordinary multi-word caption line, active-word
 * highlighted. The strong color pop is reserved for the currently-active
 * word ONLY when it's also flagged `emphasis` (a captured keyword — see
 * assemble.ts) — otherwise every merely-active function word ("the",
 * "is", "by") would get the same pop a real keyword does, which is the
 * karaoke-not-keyword problem this was built to fix.
 *
 * bigTitle: assemble.ts's keywordTitle picks give each bigTitle group
 * exactly one word, so there's no "find the active word within the
 * group" step; the group's own single word IS the card, full-screen, in
 * the format's Didone-serif kumarTitle look, sized to span edge-to-edge
 * (see fitFontSize) rather than a fixed size that reads small on a short
 * word and overflows on a long one, with a punch-in on entry.
 */

const HIGHLIGHT = "#FFD400";
const OUTRO_YELLOW = "#FFD400";

const BigTitleCard: React.FC<{ group: EdlCaptionGroup }> = ({ group }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  ensureDisplayFonts();

  const localFrame = frame - Math.round(group.tlInSec * fps);
  const progress = spring({ frame: localFrame, fps, config: { damping: 12, stiffness: 200 } });
  const scale = interpolate(progress, [0, 1], [1.35, 1]);
  const text = group.words[0].text;
  const fontSize = fitDidoneFontSize(text, width);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 40 }}>
      <div
        style={{
          fontFamily: PLAYFAIR_DISPLAY_STACK,
          fontWeight: 900,
          fontSize,
          lineHeight: 1.1,
          color: KUMAR_RED,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const LowerThirdLine: React.FC<{ group: EdlCaptionGroup; position: string; theme: string | undefined }> = ({
  group,
  position,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const tSec = frame / fps;

  const isKumar = theme === "kumar";
  const isOutro = theme === "outroYellow";
  // Kumar's own captions sit noticeably higher than a typical lower-third
  // (mid-frame, over the subject's chest, not hugging the bottom edge).
  const paddingBottomFrac = position === "center" ? 0 : isKumar ? 0.42 : 0.24;

  return (
    <AbsoluteFill
      style={{
        justifyContent: position === "center" ? "center" : "flex-end",
        alignItems: "center",
        paddingBottom: position === "center" ? 0 : height * paddingBottomFrac,
        paddingLeft: 48,
        paddingRight: 48,
      }}
    >
      <div style={{ textAlign: "center" }}>
        {group.words.map((w, i) => {
          const isActive = tSec >= w.tlStartSec && tSec < w.tlEndSec;
          const isKeywordHit = isActive && w.emphasis;
          const color = isKumar ? KUMAR_RED : isOutro ? OUTRO_YELLOW : isKeywordHit ? HIGHLIGHT : "white";
          return (
            <span
              key={i}
              style={{
                fontFamily: SYSTEM_FONT,
                fontWeight: isOutro ? 700 : 800,
                fontSize: isKumar ? 64 : isOutro ? 46 : 52,
                color,
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
}> = ({ groups, position = "lowerThird", theme: defaultTheme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tSec = frame / fps;

  const activeLowerThird = groups.find((g) => g.variant === "lowerThird" && tSec >= g.tlInSec && tSec < g.tlOutSec);
  const activeBigTitle = groups.find((g) => g.variant === "bigTitle" && tSec >= g.tlInSec && tSec < g.tlOutSec);

  if (!activeLowerThird && !activeBigTitle) return null;

  return (
    <>
      {activeLowerThird && (
        <LowerThirdLine group={activeLowerThird} position={position} theme={activeLowerThird.theme ?? defaultTheme} />
      )}
      {activeBigTitle && <BigTitleCard group={activeBigTitle} />}
    </>
  );
};

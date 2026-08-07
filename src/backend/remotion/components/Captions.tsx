import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { EdlCaptionGroup } from "../../pipeline/types";
import {
  FONT_FAMILY_SHORTHANDS,
  KUMAR_RED,
  PLAYFAIR_DISPLAY_STACK,
  SYSTEM_FONT,
  TEXT_SHADOW,
  fitDidoneFontSize,
} from "../../components/style";
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

/** Side gutters each variant's AUTOMATIC layout keeps, in composition px.
 *  A hand-positioned group is given the same content width these produce,
 *  so dragging a caption never changes how its text wraps. */
const LOWER_THIRD_GUTTER_PX = 48;
const BIG_TITLE_GUTTER_PX = 40;

/** A group the user dragged on the editor canvas carries its own center
 *  point (see EdlCaptionGroupSchema); everything else lays out
 *  automatically. Both axes are written together, so testing one is
 *  enough, but both are read to keep the type narrowing honest. */
const positionOf = (group: EdlCaptionGroup): { x: number; y: number } | null =>
  group.x !== undefined && group.y !== undefined ? { x: group.x, y: group.y } : null;

/** Resolves a group's own textCase override against the variant's default
 *  casing (bigTitle/karaokeTitle are always uppercase unless a group opts
 *  out with "none") — same override-over-default shape TextOverlay uses. */
const resolveTextTransform = (
  textCase: EdlCaptionGroup["textCase"],
  defaultUppercase: boolean,
): React.CSSProperties["textTransform"] =>
  textCase === "upper" ? "uppercase" : textCase === "lower" ? "lowercase" : textCase === "none" ? "none" : defaultUppercase ? "uppercase" : undefined;

const resolveFontFamily = (fontFamily: string | undefined, fallback: string): string =>
  fontFamily ? (FONT_FAMILY_SHORTHANDS[fontFamily] ?? fontFamily) : fallback;

/** Absolutely-positioned wrapper centered on the group's own point — the
 *  one shape both caption variants share when hand-positioned.
 *
 *  `contentWidthPx` is set EXPLICITLY rather than as a max-width: an
 *  absolutely-positioned box with `left: x%` and no `right` shrink-to-fits
 *  against only the space from x to the frame's right edge, so a caption
 *  pinned near the middle would wrap at half the width it used to — the
 *  same text re-flowing onto two lines purely because it was dragged. An
 *  explicit width matching the variant's own automatic content width
 *  makes wrapping identical before and after a move. */
const pinnedStyle = (at: { x: number; y: number }, contentWidthPx: number): React.CSSProperties => ({
  position: "absolute",
  left: `${at.x * 100}%`,
  top: `${at.y * 100}%`,
  transform: "translate(-50%, -50%)",
  width: contentWidthPx,
  textAlign: "center",
});

const BigTitleCard: React.FC<{ group: EdlCaptionGroup }> = ({ group }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  ensureDisplayFonts();

  const localFrame = frame - Math.round(group.tlInSec * fps);
  const progress = spring({ frame: localFrame, fps, config: { damping: 12, stiffness: 200 } });
  const scale = interpolate(progress, [0, 1], [1.35, 1]);
  const text = group.words[0].text;
  const fontSize = group.fontSize ?? fitDidoneFontSize(text, width, height);
  const at = positionOf(group);
  const fontFamily = resolveFontFamily(group.fontFamily, PLAYFAIR_DISPLAY_STACK);
  if (group.fontFamily) ensureDisplayFonts();

  return (
    <AbsoluteFill style={at ? undefined : { justifyContent: "center", alignItems: "center", padding: 40 }}>
      <div
        // Measured by the editor's OverlayCanvas to draw this group's drag
        // box against the REAL rendered text — see its own doc comment for
        // why it measures instead of re-deriving the geometry.
        data-caption-group={group.id}
        style={{
          ...(at ? pinnedStyle(at, width - BIG_TITLE_GUTTER_PX * 2) : null),
          fontFamily,
          fontWeight: group.fontWeight ?? 900,
          fontStyle: group.italic ? "italic" : undefined,
          textDecoration: group.underline ? "underline" : undefined,
          fontSize,
          lineHeight: 1.1,
          color: group.color ?? KUMAR_RED,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
          textTransform: resolveTextTransform(group.textCase, true),
          whiteSpace: "nowrap",
          opacity: progress,
          // A pinned card centers itself with its own translate, so the
          // entrance punch-in has to compose with it rather than replace it.
          transform: at ? `translate(-50%, -50%) scale(${scale})` : `scale(${scale})`,
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
  const { fps, width, height } = useVideoConfig();
  const tSec = frame / fps;

  const isKumar = theme === "kumar";
  const isOutro = theme === "outroYellow";
  // Kumar's own captions sit noticeably higher than a typical lower-third
  // (mid-frame, over the subject's chest, not hugging the bottom edge).
  const paddingBottomFrac = position === "center" ? 0 : isKumar ? 0.42 : 0.24;
  const at = positionOf(group);
  const fontFamily = resolveFontFamily(group.fontFamily, SYSTEM_FONT);
  if (group.fontFamily) ensureDisplayFonts();
  const textTransform = resolveTextTransform(group.textCase, false);

  return (
    <AbsoluteFill
      style={
        at
          ? undefined
          : {
              justifyContent: position === "center" ? "center" : "flex-end",
              alignItems: "center",
              paddingBottom: position === "center" ? 0 : height * paddingBottomFrac,
              paddingLeft: LOWER_THIRD_GUTTER_PX,
              paddingRight: LOWER_THIRD_GUTTER_PX,
            }
      }
    >
      <div
        // See BigTitleCard's own note — measured by the editor canvas.
        data-caption-group={group.id}
        style={at ? pinnedStyle(at, width - LOWER_THIRD_GUTTER_PX * 2) : { textAlign: "center" }}
      >
        {group.words.map((w, i) => {
          const isActive = tSec >= w.tlStartSec && tSec < w.tlEndSec;
          const isKeywordHit = isActive && w.emphasis;
          // An explicit color override is the user's own pick for this
          // caption — it replaces the automatic keyword/theme coloring
          // entirely rather than only recoloring the inactive words,
          // since a caption someone deliberately restyled is no longer
          // meant to track the template's own emphasis palette.
          const color = group.color ?? (isKumar ? KUMAR_RED : isOutro ? OUTRO_YELLOW : isKeywordHit ? HIGHLIGHT : "white");
          return (
            <span
              key={i}
              style={{
                fontFamily,
                fontWeight: group.fontWeight ?? (isOutro ? 700 : 800),
                fontStyle: group.italic ? "italic" : undefined,
                textDecoration: group.underline ? "underline" : undefined,
                fontSize: group.fontSize ?? (isKumar ? 64 : isOutro ? 46 : 52),
                color,
                textShadow: TEXT_SHADOW,
                textTransform,
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

import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { EdlCaptionGroup } from "../../pipeline/types";
import { KUMAR_RED, PLAYFAIR_DISPLAY_STACK, TEXT_SHADOW, fitDidoneFontSize } from "../../components/style";
import { ensureDisplayFonts } from "../fonts";

/**
 * karaokeTitle's own render pass — a SEPARATE component from Captions.tsx
 * on purpose, not another variant branch inside it: this needs to sit at
 * a specific point in EdlVideo.tsx's own layer stack (above the base
 * video, BELOW the fg-alpha layer — see EdlVideo.tsx's render-order doc
 * comment), whereas Captions.tsx's lowerThird/bigTitle groups render at
 * the very end, above everything. Mixing the two orderings into one
 * component would mean either moving lowerThird/bigTitle earlier too
 * (risking a regression for any OTHER format still relying on captions
 * rendering above its own CutawayOverlay events) or teaching Captions.tsx
 * to split its own render into two passes — more invasive than a second,
 * small, single-purpose component.
 *
 * Shows exactly one word at a time, full-screen, Didone serif, ALL CAPS —
 * assemble.ts already builds one "karaokeTitle" group per block carrying
 * EVERY word of that block's own line, each with its own
 * tlStartSec/tlEndSec (the same per-word timing lowerThird highlighting
 * already uses); this just picks whichever word is currently active and
 * renders it as the full-screen card, one at a time, in sequence.
 */
export const KaraokeTitleLayer: React.FC<{
  groups: EdlCaptionGroup[];
  /** Frame fraction where the title's own BOTTOM edge sits — set to the
   *  format's own talking-head headTopFrac (assemble.ts) so the subject's
   *  head rises up into the lower portion of the letters, exactly the
   *  occlusion the reference reel's own titles show. Falls back to a
   *  generic upper-third position for a format with no plates manifest. */
  baselineFrac?: number;
}> = ({ groups, baselineFrac = 0.29 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const tSec = frame / fps;
  ensureDisplayFonts();

  const karaokeGroups = groups.filter((g) => g.variant === "karaokeTitle");
  let activeWord: EdlCaptionGroup["words"][number] | undefined;
  let activeGroup: EdlCaptionGroup | undefined;
  for (const g of karaokeGroups) {
    if (tSec < g.tlInSec || tSec >= g.tlOutSec) continue;
    const w = g.words.find((w) => tSec >= w.tlStartSec && tSec < w.tlEndSec);
    if (w) {
      activeWord = w;
      activeGroup = g;
      break;
    }
  }
  if (!activeWord || !activeGroup) return null;

  // Local to the WORD's own start, not the group's — each word gets its
  // own punch-in as it becomes active, matching the reference's own
  // one-word-at-a-time rhythm instead of one entrance animation for the
  // whole line.
  const localFrame = frame - Math.round(activeWord.tlStartSec * fps);
  const progress = spring({ frame: localFrame, fps, config: { damping: 12, stiffness: 220 } });
  const scale = interpolate(progress, [0, 1], [1.3, 1]);
  const fontSize = fitDidoneFontSize(activeWord.text, width, height);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: height * (1 - baselineFrac),
        paddingLeft: 32,
        paddingRight: 32,
      }}
    >
      <div
        style={{
          fontFamily: PLAYFAIR_DISPLAY_STACK,
          fontWeight: 900,
          fontSize,
          lineHeight: 1,
          color: KUMAR_RED,
          textAlign: "center",
          textShadow: TEXT_SHADOW,
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          opacity: progress,
          transform: `scale(${scale})`,
        }}
      >
        {activeWord.text}
      </div>
    </AbsoluteFill>
  );
};

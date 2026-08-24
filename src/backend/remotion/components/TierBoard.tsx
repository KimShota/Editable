import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { SYSTEM_FONT } from "../../components/style";
import { DEFAULT_TIERS, parseTierList, tierColor } from "./tiers";

/**
 * The S/A/B/C/D(...) tier board itself, drawn from data instead of a
 * shipped picture — see category-tier-list-reveal.json's own doc comment
 * for why: this format's board always shows the full fixed tier set (no
 * per-job tier picker), so row geometry is computed here from `tiers`
 * (falling back to DEFAULT_TIERS), which is what lets an arbitrary tier
 * set/order still render correctly with zero per-format layout authoring.
 *
 * `entries` — every item revealed so far — plus `reveal`, the item THIS
 * component is currently animating in. category-tier-list-reveal.json
 * declares one TierBoard event per block, each resolved against its OWN
 * block's slots exactly as any other per-block event would be, but tags
 * every one with the SAME `mergeGroup` — assemble.ts folds them into ONE
 * EdlOverlay spanning the whole video (see schemas.ts's FormatEventSchema
 * doc comment), so THIS component only ever mounts once. Each block's own
 * moment arrives as a `states[]` patch (ordinary EdlVideo.tsx machinery)
 * updating `entries`/`reveal`/`revealStartAtSec` together — no motion or
 * pop on mount (Motion.tsx carries no DEFAULT_MOTION_BY_COMPONENT entry
 * for "TierBoard"), so the board reads as one continuous element that
 * only ever gains logos, matching the reference reel.
 *
 * The reveal animation — grow in centered over the board, hold, then fly
 * (shrink + translate, one continuous transform) into the item's row —
 * lives HERE rather than as a format-authored `layout`/`motion`, because
 * its landing target (which row, which slot index within that row, how
 * much that row has to shrink to fit) is job data no format config can
 * know ahead of time. `useCurrentFrame()` is local to this component's
 * own (now merged, whole-video) Sequence, not to any one block's own
 * start — `revealStartAtSec` (its own doc comment below) is what
 * recovers "frame 0 IS the moment this item's name starts playing" for
 * whichever block `reveal` belongs to; the phase timings after it
 * (`revealGrowSec`/`revealHoldSec`/`revealFlySec`) are measured directly
 * off the reference reel from that same per-block anchor.
 *
 * Every item — landed or flying — renders as an "icon + name" LOCKUP
 * (`name` optional: an icon-only logo still renders exactly as before).
 * The lockup's own unscaled width/height never changes across an item's
 * lifetime; only the outer `transform: scale()` and position do (hero
 * pose while flying, a row's own shrink-to-fit scale once landed) — one
 * continuous transform, same technique the icon-only version used, now
 * generalized to a box with two children instead of one square.
 *
 * An entry (landed or `reveal`) whose `tier` isn't in `tiers`, or that
 * carries no `logo`, is silently skipped rather than breaking the row
 * layout — same contract the old static rendering had for `entries`.
 */

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

type BoardItem = { logo?: string; tier?: string; name?: string };

/** No canvas text measurement available inline in a Remotion render (same
 *  constraint style.ts's fitDidoneFontSize works around) — this estimates
 *  a bold sans glyph's average width as a fraction of font size. Only
 *  used to decide how much a row (or the hero pose) needs to shrink to
 *  fit; the rendered name itself carries its own `overflow:hidden` +
 *  ellipsis safety net for whatever gap remains between this estimate and
 *  the browser's real metrics. */
const CHAR_WIDTH_FACTOR = 0.6;
const textWidthPx = (name: string, fontPx: number): number => name.length * fontPx * CHAR_WIDTH_FACTOR;

const Lockup: React.FC<{ item: BoardItem; iconPx: number; fontPx: number; gapPx: number }> = ({
  item,
  iconPx,
  fontPx,
  gapPx,
}) => (
  <div style={{ display: "flex", alignItems: "center", width: "100%", height: "100%", gap: item.name ? gapPx : 0 }}>
    <div style={{ width: iconPx, height: iconPx, flexShrink: 0 }}>
      <Img src={staticFile(item.logo!)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    </div>
    {item.name && (
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontFamily: SYSTEM_FONT,
          fontWeight: 800,
          fontSize: fontPx,
          color: "#fff",
          lineHeight: 1,
        }}
      >
        {item.name}
      </span>
    )}
  </div>
);

/** Fixed pause between a block's own nameAudioStart (see
 *  `revealStartAtSec`) and the reveal's own grow phase actually starting
 *  — small enough to feel immediate, long enough that the item doesn't
 *  pop in before the name audio itself has begun playing. */
const REVEAL_LEAD_IN_SEC = 0.15;

export const TierBoard: React.FC<{
  tiers?: string;
  entries?: BoardItem[];
  reveal?: BoardItem;
  /** Seconds into THIS overlay's own lifetime that `reveal`'s own block
   *  became active. Mounting this component fresh per block (frame 0 ===
   *  that block's own nameAudioStart) used to make this implicit; now
   *  that several blocks' own board events fold into ONE overlay
   *  spanning the whole video (assemble.ts's mergeGroup — see
   *  schemas.ts's FormatEventSchema doc comment), `useCurrentFrame()` is
   *  local to the MERGED overlay's own start instead, so each block's
   *  own start has to arrive as an explicit value (assemble.ts injects
   *  it via the format's own `mergeStartTimeParam`). Defaults to 0 for a
   *  standalone (unmerged) mount, reproducing the old per-block-mount
   *  behavior exactly. */
  revealStartAtSec?: number;
  revealGrowSec?: number;
  revealHoldSec?: number;
  revealFlySec?: number;
  boxWidthPx?: number;
  boxHeightPx?: number;
}> = ({
  tiers,
  entries = [],
  reveal,
  revealStartAtSec = 0,
  revealGrowSec = 0.45,
  revealHoldSec = 0.6,
  revealFlySec = 0.35,
  boxWidthPx,
  boxHeightPx,
}) => {
  const revealAtSec = revealStartAtSec + REVEAL_LEAD_IN_SEC;
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const boxWpx = boxWidthPx ?? width;
  const boxHpx = boxHeightPx ?? height;

  const rows = parseTierList(tiers);
  const tierList = rows.length > 0 ? rows : DEFAULT_TIERS;
  const rowHeightPx = boxHpx / tierList.length;
  const labelColWpx = boxWpx * 0.16;
  const contentWpx = boxWpx - labelColWpx;
  // Every row is the same height, so these are board-wide constants, not
  // per-row — only a row's own fit-to-width SCALE (rowLayout below)
  // varies row to row.
  const iconPx = rowHeightPx * 0.7;
  const namePx = iconPx * 0.42;
  const innerGapPx = iconPx * 0.22;
  const padXpx = rowHeightPx * 0.2;
  const itemGapPx = rowHeightPx * 0.28;

  const lockupWidthPx = (item: BoardItem): number =>
    iconPx + (item.name ? innerGapPx + textWidthPx(item.name, namePx) : 0);

  const byTier = new Map<string, BoardItem[]>();
  for (const entry of entries) {
    if (!entry.tier || !entry.logo) continue;
    const key = entry.tier.toUpperCase();
    if (!byTier.has(key)) byTier.set(key, []);
    byTier.get(key)!.push(entry);
  }

  const revealTier = reveal?.tier?.toUpperCase();
  const revealValid = Boolean(reveal?.logo && revealTier && tierList.includes(revealTier));

  /** Every item that WILL occupy this row once `reveal` lands, `reveal`
   *  included — so a row is sized for its FINAL count throughout the
   *  reveal (no jump when it lands), and the flying item's own landing
   *  target can be read straight off this row's own last box below. */
  const rowItems = (tier: string): BoardItem[] => {
    const landed = byTier.get(tier) ?? [];
    return revealValid && revealTier === tier ? [...landed, reveal!] : landed;
  };

  /** A row whose lockups don't fit at their natural (unscaled) width
   *  shrinks UNIFORMLY (icon and name together, via one outer transform
   *  per lockup) to fit — the reel's own rows never clip or overflow the
   *  board's right edge. */
  const rowLayout = (tier: string): { items: BoardItem[]; scale: number; leftBasePx: number[]; widthBasePx: number[] } => {
    const items = rowItems(tier);
    const widthBasePx = items.map(lockupWidthPx);
    const totalBasePx = widthBasePx.reduce((s, w) => s + w, 0) + Math.max(0, items.length - 1) * itemGapPx;
    const availablePx = contentWpx - 2 * padXpx;
    const scale = totalBasePx > 0 ? Math.min(1, availablePx / totalBasePx) : 1;
    const leftBasePx: number[] = [];
    let cursor = 0;
    for (const w of widthBasePx) {
      leftBasePx.push(cursor);
      cursor += w + itemGapPx;
    }
    return { items, scale, leftBasePx, widthBasePx };
  };

  // The flying reveal item's own target pose — computed unconditionally
  // off `rowLayout` above (which already counts it), so the fly phase's
  // end pose exactly matches where the item renders once landed.
  let flying: { centerX: number; centerY: number; scale: number; opacity: number } | undefined;
  let revealLanded = false;
  const revealLockupW = revealValid ? lockupWidthPx(reveal!) : 0;

  if (revealValid) {
    const revealRowIdx = tierList.indexOf(revealTier!);
    const targetLayout = rowLayout(revealTier!);
    const targetIdx = targetLayout.items.length - 1;
    const targetScale = targetLayout.scale;
    const targetLeftPx = labelColWpx + padXpx + targetScale * targetLayout.leftBasePx[targetIdx];
    const targetHeightPx = iconPx * targetScale;
    const targetTopPx = revealRowIdx * rowHeightPx + (rowHeightPx - targetHeightPx) / 2;
    const targetWidthPx = revealLockupW * targetScale;
    const targetCenterX = targetLeftPx + targetWidthPx / 2;
    const targetCenterY = targetTopPx + targetHeightPx / 2;

    const heroCenterX = boxWpx * 0.5;
    const heroCenterY = boxHpx * 0.42;
    const heroSidePx = boxHpx * 0.45;
    let heroScale = heroSidePx / iconPx;
    // Keeps a long transcribed/typed name from blowing the hero pose past
    // the board's own edges — the whole lockup shrinks together, same as
    // a crowded row does, rather than clipping.
    const heroWidthPx = revealLockupW * heroScale;
    const maxHeroWidthPx = boxWpx * 0.92;
    if (heroWidthPx > maxHeroWidthPx) heroScale *= maxHeroWidthPx / heroWidthPx;

    const growEndSec = revealAtSec + revealGrowSec;
    const holdEndSec = growEndSec + revealHoldSec;
    const flyEndSec = holdEndSec + revealFlySec;
    const tSec = frame / fps;

    if (tSec < revealAtSec) {
      // Not yet on screen.
    } else if (tSec < growEndSec) {
      const p = easeOutCubic((tSec - revealAtSec) / revealGrowSec);
      flying = { centerX: heroCenterX, centerY: heroCenterY, scale: heroScale * (0.35 + 0.65 * p), opacity: p };
    } else if (tSec < holdEndSec) {
      flying = { centerX: heroCenterX, centerY: heroCenterY, scale: heroScale, opacity: 1 };
    } else if (tSec < flyEndSec) {
      const p = easeInOutCubic((tSec - holdEndSec) / revealFlySec);
      flying = {
        centerX: heroCenterX + (targetCenterX - heroCenterX) * p,
        centerY: heroCenterY + (targetCenterY - heroCenterY) * p,
        scale: heroScale + (targetScale - heroScale) * p,
        opacity: 1,
      };
    } else {
      revealLanded = true;
    }
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        border: "3px solid #050505",
        overflow: "hidden",
      }}
    >
      {tierList.map((tier, rowIdx) => {
        const layout = rowLayout(tier);
        return (
          <div
            key={tier}
            style={{
              display: "flex",
              flex: 1,
              minHeight: 0,
              borderBottom: rowIdx < tierList.length - 1 ? "3px solid #050505" : "none",
            }}
          >
            <div
              style={{
                width: labelColWpx,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: tierColor(tier),
                borderRight: "3px solid #050505",
              }}
            >
              <span
                style={{
                  fontFamily: SYSTEM_FONT,
                  fontWeight: 900,
                  fontSize: Math.max(14, rowHeightPx * 0.42),
                  color: "#000",
                }}
              >
                {tier}
              </span>
            </div>
            <div
              style={{
                position: "relative",
                flex: 1,
                minWidth: 0,
                backgroundColor: "#262125",
              }}
            >
              {layout.items.map((item, idx) => {
                const isPendingReveal = revealValid && revealTier === tier && idx === layout.items.length - 1;
                if (isPendingReveal && !revealLanded) return null;
                const widthBasePx = layout.widthBasePx[idx];
                const heightPx = iconPx * layout.scale;
                return (
                  <div
                    key={`${tier}-${idx}`}
                    style={{
                      position: "absolute",
                      left: padXpx + layout.scale * layout.leftBasePx[idx],
                      top: (rowHeightPx - heightPx) / 2,
                      width: widthBasePx,
                      height: iconPx,
                      transform: `scale(${layout.scale})`,
                      transformOrigin: "0 0",
                      overflow: "hidden",
                    }}
                  >
                    <Lockup item={item} iconPx={iconPx} fontPx={namePx} gapPx={innerGapPx} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {flying && (
        <div
          style={{
            position: "absolute",
            left: flying.centerX - (revealLockupW * flying.scale) / 2,
            top: flying.centerY - (iconPx * flying.scale) / 2,
            width: revealLockupW,
            height: iconPx,
            transform: `scale(${flying.scale})`,
            transformOrigin: "0 0",
            opacity: flying.opacity,
            overflow: "hidden",
          }}
        >
          <Lockup item={reveal!} iconPx={iconPx} fontPx={namePx} gapPx={innerGapPx} />
        </div>
      )}
    </div>
  );
};

import { TEXT_VARIANTS, TextVariant } from "../components/style";
import { clampPillPadding, estimateBlockHeightPx, outerInsetPx } from "../components/textFit";
import { EdlCaptionGroup, EdlOverlay } from "./types";

/**
 * Module 6.5 — Text-overlay auto-layout.
 *
 * Runs once inside assemble() (see its own call site), after every
 * overlay's box has been resolved (an authored `layout`, or
 * defaultOverlayBox's centered guess) and before the EDL is frozen and
 * handed downstream — same "every decision was already made upstream"
 * contract render.ts documents for the rest of the pipeline. This is what
 * fixes a title/description card pair like cs-resources' overflowing past
 * its own box and into its neighbor: TextOverlay.tsx has never clamped
 * text to the box it's given (see TextOverlay.tsx's own `overflow:
 * hidden` doc comment for the hard backstop), and a box authored against
 * one example string doesn't necessarily fit every string a user later
 * types into it.
 *
 * The cascade (see EdlOverlaySchema's layoutLocked doc comment for the
 * one thing this deliberately never touches):
 *   1. Grow — an overlay that isn't colliding with anything just gets a
 *      box tall enough for its own authored font size, instead of being
 *      shrunk to fit a nominal box height nobody ever measured against
 *      real text metrics.
 *   2. Shrink — a genuinely colliding cluster (time AND space overlap)
 *      shrinks together, proportionally, down to a readability floor.
 *   3. Move — if shrinking alone can't clear it, stack the cluster
 *      vertically in authored top-to-bottom order, routing around any
 *      locked member (or active lowerThird caption band) as a fixed
 *      obstacle instead of through it.
 *   4. Clamp — the result is pulled inside a hard 4% frame margin; a
 *      final rect landing in a soft "Reels chrome" zone (top header,
 *      bottom caption/UI strip, right action rail) isn't force-moved
 *      there (an already-fine, reference-measured composition is never
 *      rewritten on this solver's own initiative) but is logged as a
 *      diagnostic — visible, not silently accepted.
 *
 * Deliberately scoped to TextOverlay-vs-TextOverlay (plus captions/safe
 * area as obstacles) — not StickerTitle/SkillCard/other overlay kinds,
 * which don't share this same "box the author typed one example string
 * against" failure mode today.
 */

const LINE_HEIGHT_MULTIPLIER = 1.15;
/** How close two rects have to be before the solver treats them as
 *  "touching" — a little breathing room, not just literal pixel overlap,
 *  so two cards don't end up glued edge-to-edge with zero gutter. */
const GUTTER_FRAC = 0.012;
/** Hard inset from every frame edge a solved (non-full-frame) overlay's
 *  final box is clamped inside of — see this module's own doc comment,
 *  point 4. */
const HARD_MARGIN_FRAC = 0.04;
const ABSOLUTE_MIN_FONT_PX = 16;

/** Reels/TikTok-style chrome a solved box is warned about landing in, but
 *  never force-moved out of (soft, not hard — see this module's doc
 *  comment). Approximate regions, not measured against any specific
 *  platform's current UI. */
const SOFT_ZONES: { name: string; xFrac: [number, number]; yFrac: [number, number] }[] = [
  { name: "top header", xFrac: [0, 1], yFrac: [0, 0.08] },
  { name: "bottom caption/UI strip", xFrac: [0, 1], yFrac: [0.78, 1] },
  { name: "right action rail", xFrac: [0.82, 1], yFrac: [0.45, 0.88] },
];

/** Rough band an active lowerThird caption group occupies — mirrors
 *  Captions.tsx's own paddingBottomFrac (the active line sits well up
 *  from the literal bottom edge, not flush against it), not pixel-exact
 *  against every theme. Only ever consulted for a block that actually
 *  authors `captions: true` (voice blocks) — today's broll-only formats
 *  (e.g. cs-resources) never populate edl.captions, so this path is
 *  correctly wired but dormant until a format combines the two. */
const LOWER_THIRD_CAPTION_BAND = { xFrac: [0.05, 0.95] as [number, number], yFrac: [0.7, 0.96] as [number, number] };

type PxRect = { xPx: number; yPx: number; wPx: number; hPx: number };

const rectFromFrac = (xFrac: number, yFrac: number, wFrac: number, hFrac: number, frameWidth: number, frameHeight: number): PxRect => ({
  xPx: xFrac * frameWidth,
  yPx: yFrac * frameHeight,
  wPx: wFrac * frameWidth,
  hPx: hFrac * frameHeight,
});

const rectsOverlap = (a: PxRect, b: PxRect, gutterPx: number): boolean =>
  a.xPx < b.xPx + b.wPx + gutterPx &&
  b.xPx < a.xPx + a.wPx + gutterPx &&
  a.yPx < b.yPx + b.hPx + gutterPx &&
  b.yPx < a.yPx + a.hPx + gutterPx;

const timesOverlap = (aInSec: number, aOutSec: number, bInSec: number, bOutSec: number): boolean => aInSec < bOutSec && bInSec < aOutSec;

type Candidate = {
  overlay: EdlOverlay;
  locked: boolean;
  text: string;
  fontFamily: string | undefined;
  naturalFontSizePx: number;
  minFontSizePx: number;
  authoredCenterYPx: number;
  fontSizePx: number;
  rect: PxRect;
};

/** The insets between an overlay's own box edge and where its text
 *  actually starts — TextOverlay.tsx's outer AbsoluteFill padding (only
 *  when there's no background pill; the pill's own padding already
 *  contains the text) plus the background pill's own paddingX/paddingY
 *  when set. Mirrors TextOverlay.tsx's render exactly (see its own doc
 *  comment) so the solver's predicted available space matches what
 *  actually renders. */
const computeInsets = (overlay: EdlOverlay, boxWpx: number, boxHpx: number): { xPx: number; yPx: number } => {
  const hasBackground = typeof overlay.params.background === "string";
  const outerPad = hasBackground ? 0 : outerInsetPx(boxWpx, boxHpx);
  if (!hasBackground) return { xPx: outerPad, yPx: outerPad };
  const paddingX = clampPillPadding(typeof overlay.params.paddingX === "number" ? overlay.params.paddingX : 40, boxWpx);
  const paddingY = clampPillPadding(typeof overlay.params.paddingY === "number" ? overlay.params.paddingY : 22, boxHpx);
  return { xPx: paddingX, yPx: paddingY };
};

/** Union-find over `candidates`, connecting any pair that overlaps in
 *  BOTH time and space — a title and description authored to sit one
 *  above the other, same block, are only a "collision" if their (possibly
 *  grown) rects actually touch; two cards for DIFFERENT resources never
 *  share a timeline window and never even get compared. */
const clusterByOverlap = (candidates: Candidate[]): Candidate[][] => {
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const gutterPx = GUTTER_FRAC * Math.max(...candidates.map((c) => c.rect.hPx), 1);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!timesOverlap(a.overlay.tlInSec, a.overlay.tlOutSec, b.overlay.tlInSec, b.overlay.tlOutSec)) continue;
      if (!rectsOverlap(a.rect, b.rect, gutterPx)) continue;
      union(i, j);
    }
  }
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((c, i) => {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(c);
    groups.set(root, group);
  });
  return [...groups.values()];
};

/** Step 2+3 of the cascade for one colliding cluster: shrink every
 *  movable member together first (proportional to its OWN authored size,
 *  bounded by whichever member's readability floor is hit first); if that
 *  still leaves a collision, stack the movable members vertically in
 *  authored top-to-bottom order, routing below any locked member's rect
 *  instead of through it. */
const resolveCluster = (cluster: Candidate[], movable: Candidate[], frameWidth: number, diagnostics: string[]): void => {
  const gutterPx = GUTTER_FRAC * frameWidth;
  const stillColliding = () =>
    cluster.some((a, i) =>
      cluster.slice(i + 1).some((b) => timesOverlap(a.overlay.tlInSec, a.overlay.tlOutSec, b.overlay.tlInSec, b.overlay.tlOutSec) && rectsOverlap(a.rect, b.rect, gutterPx)),
    );

  // --- Shrink, together ---
  const scaleFloor = Math.max(...movable.map((c) => c.minFontSizePx / c.naturalFontSizePx));
  const rectAtScale = (c: Candidate, scale: number): { rect: PxRect; fontSizePx: number } => {
    const fontSizePx = Math.max(ABSOLUTE_MIN_FONT_PX, c.naturalFontSizePx * scale);
    const insets = computeInsets(c.overlay, c.rect.wPx, c.rect.hPx);
    const availWidthPx = Math.max(1, c.rect.wPx - 2 * insets.xPx);
    const contentHeightPx = estimateBlockHeightPx(c.text, fontSizePx, availWidthPx, c.fontFamily, LINE_HEIGHT_MULTIPLIER);
    const heightPx = contentHeightPx + 2 * insets.yPx;
    return {
      fontSizePx,
      rect: { xPx: c.rect.xPx, yPx: c.authoredCenterYPx - heightPx / 2, wPx: c.rect.wPx, hPx: heightPx },
    };
  };
  const applyScale = (scale: number) => {
    for (const c of movable) {
      const at = rectAtScale(c, scale);
      c.fontSizePx = at.fontSizePx;
      c.rect = at.rect;
    }
  };

  applyScale(scaleFloor);
  if (stillColliding()) {
    // Even the floor doesn't clear it — binary search back up isn't
    // useful here (floor is already the smallest we'll go); fall through
    // to the move step at the floor size, which is the most room shrink
    // alone can buy this cluster.
  } else {
    let lo = scaleFloor;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      applyScale(mid);
      if (stillColliding()) hi = mid;
      else lo = mid;
    }
    applyScale(lo);
  }

  if (!stillColliding()) return;

  // --- Move: stack vertically, authored top-to-bottom order, routing
  // around locked members instead of through them ---
  const ordered = [...cluster].sort((a, b) => a.authoredCenterYPx - b.authoredCenterYPx);
  let cursorYPx = -Infinity;
  for (const c of ordered) {
    if (c.locked) {
      cursorYPx = Math.max(cursorYPx, c.rect.yPx + c.rect.hPx + gutterPx);
      continue;
    }
    const desiredTopPx = Math.max(c.rect.yPx, cursorYPx);
    c.rect = { ...c.rect, yPx: desiredTopPx };
    cursorYPx = c.rect.yPx + c.rect.hPx + gutterPx;
  }

  if (stillColliding()) {
    diagnostics.push(
      `text-overlay auto-layout: could not fully separate "${cluster.map((c) => c.overlay.id).join('", "')}" — ` +
        `shortening the text or repositioning one of them by hand will look cleaner than the automatic result.`,
    );
  }
};

/** Nudges a candidate clear of an active lowerThird caption's band — see
 *  this module's own LOWER_THIRD_CAPTION_BAND doc comment. Only ever
 *  moves UP (the band sits at the bottom; moving down would just exit the
 *  frame) and only when the candidate's OWN timeline window overlaps a
 *  caption group that's actually using the lowerThird layout. */
const avoidActiveCaptions = (candidates: Candidate[], captions: EdlCaptionGroup[], frameWidth: number, frameHeight: number): void => {
  const lowerThirdGroups = captions.filter((g) => (g.variant ?? "lowerThird") === "lowerThird");
  if (lowerThirdGroups.length === 0) return;
  const band = rectFromFrac(
    LOWER_THIRD_CAPTION_BAND.xFrac[0],
    LOWER_THIRD_CAPTION_BAND.yFrac[0],
    LOWER_THIRD_CAPTION_BAND.xFrac[1] - LOWER_THIRD_CAPTION_BAND.xFrac[0],
    LOWER_THIRD_CAPTION_BAND.yFrac[1] - LOWER_THIRD_CAPTION_BAND.yFrac[0],
    frameWidth,
    frameHeight,
  );
  for (const c of candidates) {
    if (c.locked) continue;
    const activeNearby = lowerThirdGroups.some((g) => timesOverlap(c.overlay.tlInSec, c.overlay.tlOutSec, g.tlInSec, g.tlOutSec));
    if (!activeNearby) continue;
    if (!rectsOverlap(c.rect, band, 0)) continue;
    const newBottomPx = band.yPx - GUTTER_FRAC * frameHeight;
    c.rect = { ...c.rect, yPx: newBottomPx - c.rect.hPx };
  }
};

const clampToSafeArea = (rect: PxRect, frameWidth: number, frameHeight: number): PxRect => {
  const marginXPx = HARD_MARGIN_FRAC * frameWidth;
  const marginYPx = HARD_MARGIN_FRAC * frameHeight;
  const minX = marginXPx;
  const maxX = frameWidth - marginXPx - rect.wPx;
  const minY = marginYPx;
  const maxY = frameHeight - marginYPx - rect.hPx;
  return {
    ...rect,
    xPx: maxX >= minX ? Math.min(Math.max(rect.xPx, minX), maxX) : minX,
    yPx: maxY >= minY ? Math.min(Math.max(rect.yPx, minY), maxY) : minY,
  };
};

const warnIfInSoftZone = (c: Candidate, frameWidth: number, frameHeight: number, diagnostics: string[]): void => {
  const centerXFrac = (c.rect.xPx + c.rect.wPx / 2) / frameWidth;
  const centerYFrac = (c.rect.yPx + c.rect.hPx / 2) / frameHeight;
  for (const zone of SOFT_ZONES) {
    if (centerXFrac >= zone.xFrac[0] && centerXFrac <= zone.xFrac[1] && centerYFrac >= zone.yFrac[0] && centerYFrac <= zone.yFrac[1]) {
      diagnostics.push(`text-overlay auto-layout: "${c.overlay.id}" sits in the ${zone.name} — likely to sit under the platform's own UI on Reels/TikTok.`);
    }
  }
};

export const solveTextOverlayLayout = (overlays: EdlOverlay[], frameWidth: number, frameHeight: number, captions: EdlCaptionGroup[], diagnostics: string[]): void => {
  const candidates: Candidate[] = [];
  for (const overlay of overlays) {
    if (overlay.component !== "TextOverlay") continue;
    const text = typeof overlay.params.text === "string" ? overlay.params.text : "";
    if (!text.trim()) continue;
    // A default (0,0,1,1) box is the component's own full-frame,
    // self-centering layout, not a deliberately authored region — growing
    // or clamping it isn't this solver's job (see the module doc comment).
    if (overlay.x === 0 && overlay.y === 0 && overlay.width === 1 && overlay.height === 1) continue;

    const variant = (typeof overlay.params.variant === "string" ? overlay.params.variant : "hook") as TextVariant;
    const variantDefault = TEXT_VARIANTS[variant] ?? TEXT_VARIANTS.hook;
    const naturalFontSizePx = typeof overlay.params.fontSize === "number" ? overlay.params.fontSize : variantDefault.fontSize;
    const fontFamily = typeof overlay.params.fontFamily === "string" ? overlay.params.fontFamily : undefined;
    const minFontSizePx = Math.max(ABSOLUTE_MIN_FONT_PX, naturalFontSizePx * 0.6, frameHeight * 0.026);

    const authoredRect = rectFromFrac(overlay.x, overlay.y, overlay.width, overlay.height, frameWidth, frameHeight);
    candidates.push({
      overlay,
      locked: overlay.layoutLocked,
      text,
      fontFamily,
      naturalFontSizePx,
      minFontSizePx,
      authoredCenterYPx: authoredRect.yPx + authoredRect.hPx / 2,
      fontSizePx: naturalFontSizePx,
      rect: authoredRect,
    });
  }
  if (candidates.length === 0) return;

  // Phase A — grow (never shrink) each unlocked candidate to whatever
  // height its own authored font size needs, symmetric around its
  // authored vertical center. A locked candidate's rect is the user's
  // own decision — left byte-for-byte as authored/dragged.
  for (const c of candidates) {
    if (c.locked) continue;
    const insets = computeInsets(c.overlay, c.rect.wPx, c.rect.hPx);
    const availWidthPx = Math.max(1, c.rect.wPx - 2 * insets.xPx);
    const contentHeightPx = estimateBlockHeightPx(c.text, c.fontSizePx, availWidthPx, c.fontFamily, LINE_HEIGHT_MULTIPLIER);
    const grownHeightPx = Math.max(c.rect.hPx, contentHeightPx + 2 * insets.yPx);
    c.rect = { ...c.rect, yPx: c.authoredCenterYPx - grownHeightPx / 2, hPx: grownHeightPx };
  }

  // Phase B/C — cluster and resolve genuine TextOverlay-vs-TextOverlay
  // collisions (shrink together, then stack if needed).
  for (const cluster of clusterByOverlap(candidates)) {
    if (cluster.length < 2) continue;
    const movable = cluster.filter((c) => !c.locked);
    if (movable.length === 0) continue;
    resolveCluster(cluster, movable, frameWidth, diagnostics);
  }

  // Phase C.5 — route clear of an active lowerThird caption band.
  avoidActiveCaptions(candidates, captions, frameWidth, frameHeight);

  // Phase D — hard clamp + soft-zone diagnostics, then write back.
  for (const c of candidates) {
    if (c.locked) continue;
    c.rect = clampToSafeArea(c.rect, frameWidth, frameHeight);
    warnIfInSoftZone(c, frameWidth, frameHeight, diagnostics);

    c.overlay.x = c.rect.xPx / frameWidth;
    c.overlay.y = c.rect.yPx / frameHeight;
    c.overlay.width = c.rect.wPx / frameWidth;
    c.overlay.height = c.rect.hPx / frameHeight;
    if (Math.round(c.fontSizePx) !== Math.round(c.naturalFontSizePx)) {
      c.overlay.params = { ...c.overlay.params, fontSize: Math.round(c.fontSizePx) };
    }
  }
};

/** Regression check for gates.ts's textOverlapGate — walks the FINAL,
 *  already-solved (or hand-edited-since) overlay list looking for any
 *  TextOverlay pair that still overlaps in both time and space. Only
 *  meant to catch a real defect (the solver above missed a case, or a
 *  post-solve hand edit — e.g. "Reset to template style" un-locking an
 *  overlay without re-running the solver — reintroduced one), not to
 *  second-guess a deliberate choice: a pair where BOTH members are
 *  layoutLocked, or either is the default full-frame box this module
 *  never touches (see solveTextOverlayLayout's own "isDefaultFullFrame"
 *  check above), is skipped. */
export const findUnresolvedTextOverlayCollisions = (overlays: EdlOverlay[], frameWidth: number, frameHeight: number): [string, string][] => {
  const isDefaultFullFrame = (o: EdlOverlay) => o.x === 0 && o.y === 0 && o.width === 1 && o.height === 1;
  const items = overlays
    .filter((o) => o.component === "TextOverlay" && typeof o.params.text === "string" && (o.params.text as string).trim() && !isDefaultFullFrame(o))
    .map((o) => ({ o, rect: rectFromFrac(o.x, o.y, o.width, o.height, frameWidth, frameHeight) }));

  const pairs: [string, string][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.o.layoutLocked && b.o.layoutLocked) continue;
      if (!timesOverlap(a.o.tlInSec, a.o.tlOutSec, b.o.tlInSec, b.o.tlOutSec)) continue;
      if (!rectsOverlap(a.rect, b.rect, 0)) continue;
      pairs.push([a.o.id, b.o.id]);
    }
  }
  return pairs;
};

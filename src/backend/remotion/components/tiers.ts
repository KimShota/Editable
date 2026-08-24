/**
 * Shared tier vocabulary for TierBoard.tsx and the resources UI's
 * orderedChoice/choice controls (SlotDropzone.tsx) — one module so a
 * tier's color can't drift between what the picker chip shows and what
 * the rendered board shows. Values sampled from the reference reel
 * (`~/Desktop/Editable - template/tier-list/tierlist-video-example3.mp4`)
 * for S..D; E/F extend the same red→blue ramp for formats with more rows
 * than the reference shows.
 */
export const TIER_COLORS: Record<string, string> = {
  S: "#FF7F7F",
  A: "#FFBF7F",
  B: "#FFDF7F",
  C: "#7FFF7F",
  D: "#7FFFFF",
  E: "#7FBFFF",
  F: "#BF7FFF",
};

/** Fallback for a tier label the color map doesn't recognize. */
export const DEFAULT_TIER_COLOR = "#C7C7C7";

export const DEFAULT_TIERS = ["S", "A", "B", "C", "D"];

export const tierColor = (tier: string): string => TIER_COLORS[tier.toUpperCase()] ?? DEFAULT_TIER_COLOR;

/** Parses a comma-separated, ordered tier list (e.g. "D, S, B") into
 *  trimmed, non-empty labels — the same shape TierBoard's `tiers` prop and
 *  the resources UI's orderedChoice control both read/write as one plain
 *  string binding. */
export const parseTierList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

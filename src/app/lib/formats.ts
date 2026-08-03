import "server-only";
import fs from "node:fs";
import path from "node:path";
import { listFormats, loadFormat } from "@backend/pipeline/loader";
import { allSlots } from "@backend/pipeline/intake";
import { Format, Slot } from "@backend/pipeline/types";
import { repoRoot } from "@backend/pipeline/paths";
import { listJobs } from "./jobs";

/**
 * Read-side view of the format library for the app UI: adds the things a
 * template picker needs (required slots, a rough filming-time estimate, an
 * example render) on top of the engine's own Format shape. Derived only —
 * nothing here is persisted, so a new formats/<id>.json shows up for free.
 */

export type ReferenceReel = {
  url: string;
  uploader: string;
  likes: number;
  comments: number;
};

export type FormatSummary = {
  id: string;
  name: string;
  niche: string;
  description: string;
  blockCount: number;
  requiredSlots: Slot[];
  optionalSlotCount: number;
  estimatedMinutes: number;
  exampleVideoUrl: string | null;
  reel: ReferenceReel | null;
};

/** Minutes to film one slot, by media type — a rough, honest estimate. */
const SLOT_MINUTES: Record<Slot["mediaType"], number> = {
  video: 1.5,
  image: 0.5,
  audio: 0.5,
  text: 0.25,
};

const estimateMinutes = (format: Format): number => {
  const minutes = allSlots(format).reduce((sum, slot) => sum + SLOT_MINUTES[slot.mediaType], 0);
  return Math.max(3, Math.round(minutes));
};

/** First existing rendered job for this format, used as the gallery preview. */
const findExampleVideoUrl = (formatId: string): string | null => {
  const jobs = listJobs();
  const rendered = jobs.find((j) => j.formatId === formatId && j.rendered);
  return rendered ? `/api/media/out/${rendered.id}.mp4` : null;
};

const reelsPath = path.join(repoRoot, "formats", "meta", "reels.json");
type ReelsFile = Record<string, { url: string; uploader: string; likes: number; comments: number }>;

/** Reads formats/meta/reels.json once per process — small, rarely-changing
 *  reference data (see reelsSync.ts, the only writer), not worth re-reading
 *  per request. Lives in a subdirectory, not formatsDir itself, since
 *  loader.ts's listFormats() treats every *.json directly in formatsDir as
 *  a Format to enumerate (same reasoning as formatStylesDir). Absent
 *  entirely in an environment with no reels configured. */
let cachedReels: ReelsFile | null = null;
const loadReels = (): ReelsFile => {
  if (cachedReels) return cachedReels;
  cachedReels = (fs.existsSync(reelsPath) ? JSON.parse(fs.readFileSync(reelsPath, "utf8")) : {}) as ReelsFile;
  return cachedReels;
};

/** Only claims a reel for a format when BOTH the metadata entry AND its
 *  staged video (public/reels/<id>.mp4) exist — a reels.json entry with no
 *  downloaded clip yet (see the gallery redesign's yt-dlp staging step)
 *  shouldn't render a broken <video> src. */
const findReel = (formatId: string): ReferenceReel | null => {
  const entry = loadReels()[formatId];
  if (!entry) return null;
  if (!fs.existsSync(path.join(repoRoot, "public", "reels", `${formatId}.mp4`))) return null;
  return { url: entry.url, uploader: entry.uploader, likes: entry.likes, comments: entry.comments };
};

export const getFormatSummary = (formatId: string): FormatSummary => {
  const format = loadFormat(formatId);
  const slots = allSlots(format);
  return {
    id: format.id,
    name: format.name,
    niche: format.niche,
    description: format.description,
    blockCount: format.blocks.length,
    requiredSlots: slots.filter((s) => s.required),
    optionalSlotCount: slots.filter((s) => !s.required).length,
    estimatedMinutes: estimateMinutes(format),
    exampleVideoUrl: findExampleVideoUrl(format.id),
    reel: findReel(format.id),
  };
};

export const listFormatSummaries = (): FormatSummary[] =>
  listFormats()
    .map(getFormatSummary)
    .sort((a, b) => a.name.localeCompare(b.name));

export const listNiches = (): string[] =>
  Array.from(new Set(listFormatSummaries().map((f) => f.niche))).sort();

/** Whether formats/<id>.json exists at all, for 404 handling. */
export const formatExists = (formatId: string): boolean =>
  fs.existsSync(path.join(repoRoot, "formats", `${formatId}.json`));

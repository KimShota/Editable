import "server-only";
import fs from "node:fs";
import path from "node:path";
import { listFormats, loadFormat } from "../../pipeline/loader";
import { allSlots } from "../../pipeline/intake";
import { Format, Slot } from "../../pipeline/types";
import { repoRoot } from "../../pipeline/paths";
import { listJobs } from "./jobs";

/**
 * Read-side view of the format library for the app UI: adds the things a
 * template picker needs (required slots, a rough filming-time estimate, an
 * example render) on top of the engine's own Format shape. Derived only —
 * nothing here is persisted, so a new formats/<id>.json shows up for free.
 */

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

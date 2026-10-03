import { z } from "zod";

/**
 * The 14-day plan of one brand: `brands/<slug>/plan.json`
 * (plan/ui-ux-full-flow.md §2.2). A card is one day's video. Its script,
 * storyboard and produced video are all keyed by the card's id; the card
 * points at the viral source whose spec it recreates, and several cards may
 * share one source (same format, different angle).
 */

export const CARD_STATUSES = [
  "draft",
  "approved",
  "queued",
  "generating",
  "internal_review",
  "needs_review",
  "ready",
  "posted",
  "skipped",
  "failed",
] as const;
export const CardStatusSchema = z.enum(CARD_STATUSES);
export type CardStatus = z.infer<typeof CardStatusSchema>;

export const ACTORS = ["customer", "admin", "system"] as const;
export type Actor = (typeof ACTORS)[number];

export const CYCLE_DAYS = 14;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const CardSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  /** 1..14 within the cycle. */
  day: z.number().int().min(1).max(CYCLE_DAYS),
  sourceId: z.string().min(1),
  /** What this card says, one line. */
  angle: z.string(),
  /** First adapted line, copied here for list and calendar display. */
  hook: z.string().default(""),
  status: CardStatusSchema,
  /** A ⚠️ overlay on top of the status, not a state of its own: set by QC
   *  when a clip passed on its last retry (plan §6). */
  lowConfidence: z.boolean().default(false),
  /** Other sources that could back this day, for "Swap". */
  alternates: z.array(z.object({ sourceId: z.string().min(1), angle: z.string() })).default([]),
  /** From `video.estimate` (produce clips --dry): what releasing it costs. */
  estimateUsd: z.number().nonnegative().optional(),
  /** The most it can cost if every allowed retry is used (production/retry.ts). */
  estimateMaxUsd: z.number().nonnegative().optional(),
  thumbsDown: z.object({ reason: z.string(), note: z.string().optional(), at: z.string() }).optional(),
  /** Status transitions, newest last, capped (see MAX_HISTORY). */
  history: z
    .array(z.object({ at: z.string(), from: CardStatusSchema, to: CardStatusSchema, by: z.enum(ACTORS) }))
    .default([]),
});
export type Card = z.infer<typeof CardSchema>;

export const PlanSchema = z.object({
  cycleId: z.string().min(1),
  /** Day 1 of the cycle (a date, no time zone: the brand's own calendar). */
  startsOn: IsoDate,
  /** The angle locked for this cycle (niche.json's chosen angle). */
  niche: z.object({ angleId: z.string(), title: z.string() }).nullable().default(null),
  cards: z.array(CardSchema),
  /** Bumped on every write. Lets a writer detect that someone else saved
   *  first (the app and the worker are separate processes). */
  rev: z.number().int().nonnegative().default(0),
});
export type Plan = z.infer<typeof PlanSchema>;

/** True for an http or https address. Never throws, so it is safe to chain after `.url()`, whose
 *  failure does not stop later checks from running. */
export const isWebAddress = (u: string): boolean => URL.canParse(u) && /^https?:$/i.test(new URL(u).protocol);

/** The caption and posting state of one produced video:
 *  `videos/<cardId>/post.json`. Kept apart from plan.json so editing a
 *  caption never contends with a status change. */
export const PostDetailsSchema = z.object({
  caption: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
  /** Platforms the customer plans to post to. Auto-posting is a shell in
   *  Phase 1, so this is a note for the manual flow. */
  platforms: z.array(z.enum(["tiktok", "instagram", "youtube"])).default([]),
  // Shown to people as links, so only web addresses: a javascript: or data: URL must never be stored.
  postedUrls: z.array(z.string().url().refine(isWebAddress, "must be an http or https address")).default([]),
  postedAt: z.string().optional(),
});
export type PostDetails = z.infer<typeof PostDetailsSchema>;

/** `brands/<slug>/niche.json`: the angles proposed for the brand and the one
 *  the customer picked. */
export const NicheAngleSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  whyItFits: z.string(),
  exampleHooks: z.array(z.string()).default([]),
});
export const NicheSchema = z.object({
  angles: z.array(NicheAngleSchema),
  chosenAngleId: z.string().nullable().default(null),
  proposedAt: z.string(),
});
export type NicheAngle = z.infer<typeof NicheAngleSchema>;
export type Niche = z.infer<typeof NicheSchema>;

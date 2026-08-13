import "server-only";
import { sql } from "./db";
import { readJobManifest } from "./jobs";
import type { SessionUser } from "./session";

/**
 * Per-user daily cap on build/render attempts — the only thing that bounds
 * API spend once someone is past the invite gate. The gate controls WHO can
 * trigger a paid Anthropic/Gemini/Higgsfield call; this controls HOW MUCH
 * any one of them can run up, which nothing else in the app does (see
 * db/migrations/003_pipeline_runs.sql's own doc comment).
 *
 * Also carries the global kill switch (PIPELINE_DISABLED) — a separate
 * concern from the per-user quota, but the same call site in both routes
 * wants to check both before doing any work, so they're exposed together.
 *
 * On top of the rolling daily rate, a handful of formats carry their own
 * LIFETIME cap (see FORMAT_LIFETIME_LIMITS below) — a fixed number of
 * build/render attempts per user, ever, never resetting. "Attempt" not
 * "success," same accounting as the daily count and for the same reason
 * (see db/migrations/003_pipeline_runs.sql: a failed build already spent
 * the Anthropic/Gemini calls behind it).
 */

export type QuotaResult = { ok: true } | { ok: false; error: string; status: 429 | 503 };

export type QuotaStatus =
  | { unlimited: true }
  | { unlimited: false; limit: number; used: number; remaining: number };

const DEFAULT_DAILY_LIMIT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * PIPELINE_DAILY_LIMIT_PER_USER: unset falls back to DEFAULT_DAILY_LIMIT —
 * quota is meant to be on by default, not opt-in, since it's what makes an
 * invite-gated signup actually safe to hand out. An explicit "0" (or a
 * negative/garbage value) means unlimited: distinct from "0 uses left",
 * which would lock everyone out including future non-admins by mistake the
 * moment the env var is merely absent.
 */
const dailyLimit = (): number => {
  if (process.env.PIPELINE_DAILY_LIMIT_PER_USER === undefined) return DEFAULT_DAILY_LIMIT;
  const raw = Number(process.env.PIPELINE_DAILY_LIMIT_PER_USER);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

/** Formats capped at a fixed lifetime total per user, on top of (not
 *  instead of) the daily rate above — a plain in-code map, not an env
 *  var, since this is a per-format product decision ("this template is
 *  limited-run") rather than an operational knob meant to be tuned per
 *  deploy the way the daily rate is. */
const FORMAT_LIFETIME_LIMITS: Record<string, number> = {
  // "Kumar Method" — a heavier, more personal template (talking-head +
  // generated b-roll + a name/likeness triptych); one per account, ever.
  "cinematic-debut-manifesto": 1,
};

/** Rolling-24h attempt count for this user — shared by checkAndRecordQuota's
 *  own check and getQuotaStatus's read-only peek, so the two can't drift on
 *  what "used" means. */
const countUsed = async (userId: string): Promise<number> => {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const rows = await sql`
    select count(*)::int as count from pipeline_runs
    where user_id = ${userId} and created_at >= ${since}
  `;
  return (rows[0] as { count: number }).count;
};

/** All-time attempt count for this user on ONE format — across every job
 *  of that format, not just the one being checked right now, and with no
 *  time window (see FORMAT_LIFETIME_LIMITS). */
const countUsedForFormat = async (userId: string, formatId: string): Promise<number> => {
  const rows = await sql`
    select count(*)::int as count from pipeline_runs
    where user_id = ${userId} and format_id = ${formatId}
  `;
  return (rows[0] as { count: number }).count;
};

/**
 * Read-only: how much of today's quota is left, without recording an
 * attempt — for showing a "N videos left today" indicator in the UI. Mirrors
 * checkAndRecordQuota's own unlimited rules (admin, or the env var set to
 * unlimited) so the two never disagree about who's capped.
 */
export const getQuotaStatus = async (user: SessionUser): Promise<QuotaStatus> => {
  if (user.isAdmin) return { unlimited: true };
  const limit = dailyLimit();
  if (limit === 0) return { unlimited: true };
  const used = await countUsed(user.id);
  return { unlimited: false, limit, used, remaining: Math.max(0, limit - used) };
};

/**
 * Checks quota/kill-switch and, if allowed, records the attempt — atomic
 * enough for friends-scale traffic (see auth.ts's signup() for the same
 * "good enough, not bulletproof" reasoning). Two simultaneous requests can
 * both pass the check before either INSERTs, so the true cap is the
 * configured limit plus a small margin under concurrent load; fixing that
 * exactly needs a transaction with a row lock, which isn't worth it against
 * PIPELINE_MAX_CONCURRENT=2's own ceiling on how much concurrency is even
 * possible here.
 *
 * Call this BEFORE spawning the pipeline child process — the row records an
 * attempt, not a success, because a build that fails after calling
 * Anthropic/Gemini has still spent the money. That's true of a
 * FORMAT_LIFETIME_LIMITS format too: a failed build/render on a limited
 * template still permanently spends one of the user's lifetime attempts on
 * it, same "attempt, not success" accounting as the daily cap — no retry
 * on failure for a 1-per-account template, by design (see the format's own
 * commit message/PR for the product reasoning if that ever needs revisiting).
 */
export const checkAndRecordQuota = async (
  user: SessionUser,
  jobId: string,
  kind: "build" | "render",
): Promise<QuotaResult> => {
  if (process.env.PIPELINE_DISABLED === "1") {
    return { ok: false, error: "builds and renders are temporarily paused — try again later", status: 503 };
  }

  // Admins are exempt from every cap here — daily rate AND per-format
  // lifetime — same reasoning either way: they're the operator, not a
  // spend risk the quota needs to guard against, and a locked-out admin
  // can't raise their own limit without SSH access anyway.
  if (user.isAdmin) return { ok: true };

  const formatId = readJobManifest(jobId).format;

  const lifetimeLimit = FORMAT_LIFETIME_LIMITS[formatId];
  if (lifetimeLimit !== undefined) {
    const usedLifetime = await countUsedForFormat(user.id, formatId);
    if (usedLifetime >= lifetimeLimit) {
      return {
        ok: false,
        error: `this template is limited to ${lifetimeLimit} video${lifetimeLimit === 1 ? "" : "s"} per account, ever — you've already used ${lifetimeLimit === 1 ? "yours" : "your limit"}`,
        status: 429,
      };
    }
  }

  const limit = dailyLimit();
  if (limit > 0) {
    const used = await countUsed(user.id);
    if (used >= limit) {
      return {
        ok: false,
        error: `daily build/render limit reached (${limit}/24h) — try again later`,
        status: 429,
      };
    }
  }

  // Recorded for BOTH the daily rolling count (when that's capped) and any
  // format's own lifetime count (see FORMAT_LIFETIME_LIMITS) — always, even
  // when the daily rate itself is unlimited (PIPELINE_DAILY_LIMIT_PER_USER
  // set to 0), since a lifetime cap still needs this row to ever trigger.
  await sql`insert into pipeline_runs (user_id, job_id, kind, format_id) values (${user.id}, ${jobId}, ${kind}, ${formatId})`;
  return { ok: true };
};

import "server-only";
import { sql } from "./db";
import { readJobManifest } from "./jobs";
import type { SessionUser } from "./session";
import { loadFormat } from "@backend/pipeline/loader";

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
 * Access is plan-based:
 *  - Free users get a FREE_TRIAL_DAYS-long trial (from users.created_at),
 *    during which every format except PREMIUM_ONLY_FORMATS is available up
 *    to freeTrialDailyLimit()/day. Once the trial window has passed, a free
 *    user is locked out entirely — Premium is the only way back in.
 *  - Premium users get every format, including PREMIUM_ONLY_FORMATS, up to
 *    premiumDailyLimit()/day.
 *  - Admins bypass every cap here — they're the operator, not a spend risk
 *    the quota needs to guard against, and a locked-out admin can't raise
 *    their own limit without SSH access anyway.
 */

export type QuotaResult = { ok: true } | { ok: false; error: string; status: 429 | 503 };

export type QuotaStatus =
  | { unlimited: true }
  | { unlimited: false; limit: number; used: number; remaining: number };

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many days of full-ish access a free account gets before it's locked
 *  behind Premium — an operational knob, kept in an env var for the same
 *  reason the daily limits below are. */
export const freeTrialDays = (): number => {
  const raw = Number(process.env.FREE_TRIAL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
};

/**
 * FREE_TRIAL_DAILY_LIMIT_PER_USER: build/render attempts per day for a free
 * account still inside its trial window. Unset falls back to 3. An explicit
 * "0" (or negative/garbage) means unlimited-during-trial, same convention as
 * premiumDailyLimit() below.
 */
export const freeTrialDailyLimit = (): number => {
  if (process.env.FREE_TRIAL_DAILY_LIMIT_PER_USER === undefined) return 3;
  const raw = Number(process.env.FREE_TRIAL_DAILY_LIMIT_PER_USER);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

/**
 * PREMIUM_DAILY_LIMIT_PER_USER: build/render attempts per day for a Premium
 * subscriber. Unset falls back to 10. An explicit "0" (or negative/garbage)
 * means unlimited — distinct from "0 uses left", which would lock out every
 * subscriber the moment the env var is merely absent.
 */
export const premiumDailyLimit = (): number => {
  if (process.env.PREMIUM_DAILY_LIMIT_PER_USER === undefined) return 10;
  const raw = Number(process.env.PREMIUM_DAILY_LIMIT_PER_USER);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
};

/** Formats gated behind Premium entirely — a free user can't use these at
 *  any point, trial or not. A plain in-code set, not an env var, since this
 *  is a per-format product decision rather than an operational knob meant
 *  to be tuned per deploy the way the daily rates are. */
const PREMIUM_ONLY_FORMATS = new Set<string>([
  // "Kumar Method" — a heavier, more personal template (talking-head +
  // generated b-roll + a name/likeness triptych).
  "cinematic-debut-manifesto",
]);

/** Whether `user` is still inside their free trial window. Only meaningful
 *  for plan === "free" — a Premium user's access is governed by
 *  premiumDailyLimit() instead, regardless of when they signed up. */
export const isInFreeTrial = (user: SessionUser): boolean => {
  const trialEndsAt = new Date(user.createdAt).getTime() + freeTrialDays() * WINDOW_MS;
  return Date.now() < trialEndsAt;
};

type DailyAccess =
  | { kind: "unlimited" }
  | { kind: "limited"; limit: number }
  | { kind: "locked"; reason: string };

/** The plan/trial rule above, resolved to a daily-rate outcome — shared by
 *  getQuotaStatus's read-only peek and checkAndRecordQuota's own check so
 *  the two can't drift on what a given user is allowed. */
const resolveDailyAccess = (user: SessionUser): DailyAccess => {
  if (user.plan === "premium") {
    const limit = premiumDailyLimit();
    return limit === 0 ? { kind: "unlimited" } : { kind: "limited", limit };
  }
  if (isInFreeTrial(user)) {
    const limit = freeTrialDailyLimit();
    return limit === 0 ? { kind: "unlimited" } : { kind: "limited", limit };
  }
  return {
    kind: "locked",
    reason: `your ${freeTrialDays()}-day free trial has ended — upgrade to Premium to keep creating`,
  };
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

/**
 * Read-only: how much of today's quota is left, without recording an
 * attempt — for showing a "N videos left today" indicator in the UI. Mirrors
 * checkAndRecordQuota's own rules so the two never disagree about who's
 * capped. A locked-out (trial-expired) free user reports as 0/0 remaining
 * rather than a separate shape — still true today, and every day after,
 * until they upgrade.
 */
export const getQuotaStatus = async (user: SessionUser): Promise<QuotaStatus> => {
  if (user.isAdmin) return { unlimited: true };
  const access = resolveDailyAccess(user);
  if (access.kind === "unlimited") return { unlimited: true };
  if (access.kind === "locked") return { unlimited: false, limit: 0, used: 0, remaining: 0 };
  const used = await countUsed(user.id);
  return { unlimited: false, limit: access.limit, used, remaining: Math.max(0, access.limit - used) };
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
 * Anthropic/Gemini has still spent the money.
 */
export const checkAndRecordQuota = async (
  user: SessionUser,
  jobId: string,
  kind: "build" | "render",
): Promise<QuotaResult> => {
  if (process.env.PIPELINE_DISABLED === "1") {
    return { ok: false, error: "builds and renders are temporarily paused — try again later", status: 503 };
  }

  if (user.isAdmin) return { ok: true };

  const formatId = readJobManifest(jobId).format;

  if (PREMIUM_ONLY_FORMATS.has(formatId) && user.plan !== "premium") {
    const format = loadFormat(formatId);
    return {
      ok: false,
      error: `${format.name} is a Premium-only template — upgrade to unlock it`,
      status: 429,
    };
  }

  const access = resolveDailyAccess(user);
  if (access.kind === "locked") {
    return { ok: false, error: access.reason, status: 429 };
  }
  if (access.kind === "limited") {
    const used = await countUsed(user.id);
    if (used >= access.limit) {
      return {
        ok: false,
        error: `daily build/render limit reached (${access.limit}/24h) — try again later`,
        status: 429,
      };
    }
  }

  await sql`insert into pipeline_runs (user_id, job_id, kind, format_id) values (${user.id}, ${jobId}, ${kind}, ${formatId})`;
  return { ok: true };
};

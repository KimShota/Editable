import "server-only";
import { sql } from "./db";
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
 */

export type QuotaResult = { ok: true } | { ok: false; error: string; status: 429 | 503 };

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

  // Admins are exempt: they're the operator, not a spend risk the quota
  // needs to guard against, and a locked-out admin can't raise their own
  // limit without SSH access anyway.
  if (user.isAdmin) return { ok: true };

  const limit = dailyLimit();
  if (limit === 0) return { ok: true };

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const rows = await sql`
    select count(*)::int as count from pipeline_runs
    where user_id = ${user.id} and created_at >= ${since}
  `;
  const used = (rows[0] as { count: number }).count;
  if (used >= limit) {
    return {
      ok: false,
      error: `daily build/render limit reached (${limit}/24h) — try again later`,
      status: 429,
    };
  }

  await sql`insert into pipeline_runs (user_id, job_id, kind) values (${user.id}, ${jobId}, ${kind})`;
  return { ok: true };
};

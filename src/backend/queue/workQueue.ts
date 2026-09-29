import type { QueryFn } from "../../app/lib/db";

/**
 * Postgres-backed durable job queue (creator-brand-memory plan, M0).
 *
 * The queue is a table (db/migrations/010_work_queue.sql) plus this module.
 * Every operation is ONE SQL statement, which is what makes it safe over
 * Neon's stateless HTTP driver (no session, no multi-statement
 * transaction): a claim is a single UPDATE whose subselect takes the row
 * with `FOR UPDATE SKIP LOCKED`, so concurrent workers each get a different
 * row and none waits on another.
 *
 * Semantics:
 *  - at-least-once: a worker that dies mid-job leaves the row `running`;
 *    `reclaimStale` returns it to `queued` once its lock stops being
 *    refreshed, so handlers MUST be idempotent (analysis is: it is keyed by
 *    content hash).
 *  - `attempts` counts claims. A job that has used all `max_attempts` goes
 *    to `failed` (the dead letter) with its last error kept for inspection.
 *  - a retry is delayed by exponential backoff (`retryDelaySec`).
 *  - `complete`/`fail`/`touch` only act on a row still locked by the calling
 *    worker, so a worker whose lock expired and whose job was handed to
 *    another cannot overwrite the new run's outcome.
 */

export type QueueJob = {
  id: number;
  kind: string;
  payload: unknown;
  /** Claims so far, including the current one (1 on the first run). */
  attempts: number;
  maxAttempts: number;
};

export type EnqueueOptions = {
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Don't run before this time. Default: now. */
  runAfter?: Date;
  /** Default 3. */
  maxAttempts?: number;
  /** While a job with this (kind, dedupeKey) is queued or running, enqueueing
   *  the same pair again is a no-op. */
  dedupeKey?: string;
};

export type FailOutcome = "retry" | "failed" | "lost";

/** Exponential backoff before retry number `attempts` (the attempt that
 *  just failed): base, 2·base, 4·base … capped. Pure, so it is tested
 *  without a database. */
export const retryDelaySec = (attempts: number, baseSec = 30, capSec = 3600): number =>
  Math.min(capSec, baseSec * 2 ** Math.max(0, attempts - 1));

const MAX_ERROR_CHARS = 2000;

const toJob = (row: Record<string, unknown>): QueueJob => ({
  id: Number(row.id),
  kind: String(row.kind),
  payload: row.payload,
  attempts: Number(row.attempts),
  maxAttempts: Number(row.max_attempts),
});

export class WorkQueue {
  constructor(private readonly query: QueryFn) {}

  /** Returns the new job's id, or null when `dedupeKey` matched a job that
   *  is still queued or running. */
  async enqueue(kind: string, payload: unknown, opts: EnqueueOptions = {}): Promise<number | null> {
    const rows = await this.query(
      `insert into work_queue (kind, payload, priority, run_after, max_attempts, dedupe_key)
       values ($1, $2::jsonb, $3, coalesce($4::timestamptz, now()), $5, $6)
       on conflict (kind, dedupe_key) where dedupe_key is not null and status in ('queued', 'running')
       do nothing
       returning id`,
      [
        kind,
        JSON.stringify(payload ?? {}),
        opts.priority ?? 0,
        opts.runAfter ? opts.runAfter.toISOString() : null,
        opts.maxAttempts ?? 3,
        opts.dedupeKey ?? null,
      ],
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  /** Takes the next runnable job of one of `kinds`, or null. */
  async claim(workerId: string, kinds: string[]): Promise<QueueJob | null> {
    if (kinds.length === 0) return null;
    const rows = await this.query(
      `update work_queue
          set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1
        where id = (
          select id from work_queue
           where status = 'queued' and run_after <= now() and kind = any($2::text[])
           order by priority desc, run_after, id
           for update skip locked
           limit 1
        )
        returning id, kind, payload, attempts, max_attempts`,
      [workerId, kinds],
    );
    return rows.length > 0 ? toJob(rows[0]) : null;
  }

  /** Refreshes the lock so a long job isn't reclaimed as stale. Returns
   *  false if this worker no longer holds the job. */
  async touch(job: QueueJob, workerId: string): Promise<boolean> {
    const rows = await this.query(
      `update work_queue set locked_at = now()
        where id = $1 and locked_by = $2 and status = 'running' returning id`,
      [job.id, workerId],
    );
    return rows.length > 0;
  }

  /** Returns false if this worker no longer holds the job (its lock expired
   *  and it was reclaimed) — the result is then discarded, not written. */
  async complete(job: QueueJob, workerId: string, result?: unknown): Promise<boolean> {
    const rows = await this.query(
      `update work_queue
          set status = 'done', result = $3::jsonb, finished_at = now(),
              locked_at = null, locked_by = null, last_error = null
        where id = $1 and locked_by = $2 and status = 'running'
        returning id`,
      [job.id, workerId, result === undefined ? null : JSON.stringify(result)],
    );
    return rows.length > 0;
  }

  /** Records a failure: back to `queued` with backoff while attempts remain,
   *  else `failed`. */
  async fail(job: QueueJob, workerId: string, error: unknown, retryBaseSec = 30): Promise<FailOutcome> {
    const message = (error instanceof Error ? error.stack || error.message : String(error)).slice(0, MAX_ERROR_CHARS);
    const rows = await this.query(
      `update work_queue
          set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
              run_after = case when attempts >= max_attempts then run_after
                               else now() + ($3::int * interval '1 second') end,
              finished_at = case when attempts >= max_attempts then now() else null end,
              last_error = $4, locked_at = null, locked_by = null
        where id = $1 and locked_by = $2 and status = 'running'
        returning status`,
      [job.id, workerId, retryDelaySec(job.attempts, retryBaseSec), message],
    );
    if (rows.length === 0) return "lost";
    return rows[0].status === "failed" ? "failed" : "retry";
  }

  /** Returns `running` rows whose lock hasn't been refreshed for
   *  `lockTimeoutSec` to the queue (or to `failed` if out of attempts).
   *  Returns how many were reclaimed. */
  async reclaimStale(lockTimeoutSec: number): Promise<number> {
    const rows = await this.query(
      `update work_queue
          set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
              finished_at = case when attempts >= max_attempts then now() else null end,
              last_error = 'worker lock expired', locked_at = null, locked_by = null
        where status = 'running' and locked_at < now() - ($1::int * interval '1 second')
        returning id`,
      [Math.round(lockTimeoutSec)],
    );
    return rows.length;
  }

  /** Counts by status, for a health check or the CLI. */
  async stats(): Promise<Record<string, number>> {
    const rows = await this.query(`select status, count(*)::int as n from work_queue group by status`);
    const out: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const r of rows) out[String(r.status)] = Number(r.n);
    return out;
  }
}

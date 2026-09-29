import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { QueryFn } from "../../app/lib/db";
import { analyzeVideoFile } from "../analysis/analyzer";
import { createAnalysisHandlers, createAnalyzeHandler, enqueueAnalysis } from "../analysis/handler";
import { getAnalysis, getVideo, insertVideo, saveAnalysis } from "../analysis/store";
import { makePunchInVideo } from "../analysis/tools/fixtures";
import { ANALYZER_VERSION } from "../analysis/version";
import { repoRoot } from "../pipeline/paths";
import { runOnce, runWorker } from "../queue/worker";
import { QueueJob, retryDelaySec, WorkQueue } from "../queue/workQueue";
import { STYLE_DIM_COUNT } from "../style/dims";
import { neutralStyleSpec } from "../style/defaults";
import { getStyleSpec, saveStyleSpec } from "../style/store";
import { hashFile, LocalStorage, videoKey } from "../storage";
import { makeChecker } from "./checks";
import { splitStatements } from "./sqlMigrations";

/**
 * Real SQL against a real (in-process) Postgres: every migration in
 * db/migrations applied through the same splitter migrate.ts uses, then the
 * queue, the analysis and style stores, and the analyze handler on top.
 *
 *   npm run test:db
 *
 * WHAT THIS DOES NOT COVER, honestly:
 *  - pgvector. PGlite ships without it, so `create extension vector`, the
 *    `vector(N)` columns and the hnsw indexes are shimmed (below): columns
 *    become a text-backed domain named `vector`, index statements are
 *    skipped. The literal format ('[0.1,0.2]'::vector) and the width are
 *    checked; similarity search itself is not run.
 *  - SKIP LOCKED contention. PGlite is one connection, so two workers never
 *    truly race for a row; claim ordering, exclusivity and the lock-guarded
 *    complete/fail are covered, the row-lock behavior under load is not.
 *  - Neon's HTTP driver. The stores take a `query` function, and this passes
 *    PGlite's; the real one (app/lib/db.ts) is a thin wrapper over
 *    neon().query and is not exercised here.
 */

/** JSON with object keys sorted, so two values compare equal regardless of key
 *  order. Postgres jsonb does not preserve key order (it sorts by length, then
 *  bytes), so a stored-and-reloaded object rarely stringifies identically. */
const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const shimVectorStatements = (statements: string[]): string[] =>
  statements
    .filter((s) => !/^create extension\b.*\bvector\b/i.test(s) && !/\busing hnsw\b/i.test(s))
    .map((s) => s.replace(/vector\(\d+\)/g, "vector"));

const applyMigrations = async (db: PGlite, only?: (file: string) => boolean): Promise<number> => {
  const dir = path.join(repoRoot, "db/migrations");
  let statements = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && (!only || only(f))).sort()) {
    for (const stmt of shimVectorStatements(splitStatements(fs.readFileSync(path.join(dir, file), "utf8")))) {
      try {
        await db.exec(stmt);
        statements++;
      } catch (err) {
        throw new Error(`migration ${file} failed on:\n${stmt}\n→ ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return statements;
};

const main = async () => {
  const t = makeChecker();
  const db = new PGlite();
  const query: QueryFn = async (text, params = []) => (await db.query(text, params)).rows as Record<string, unknown>[];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "editable-db-checks-"));

  try {
    // -----------------------------------------------------------------
    console.log("migrations");
    await db.exec("create domain vector as text");
    const applied = await applyMigrations(db);
    t.check("all migrations apply cleanly", applied > 30, `${applied} statements`);
    const tables = (await query(`select table_name from information_schema.tables where table_schema = 'public'`)).map((r) => String(r.table_name));
    for (const name of ["work_queue", "videos", "video_metrics", "video_analyses", "style_specs"]) {
      t.check(`table ${name} exists`, tables.includes(name));
    }
    // Not every migration is: 007 does a bare `add constraint`. That is fine in
    // production (migrate.ts records applied files and never re-runs one), so
    // only this milestone's migrations are held to being re-runnable.
    let rerun = true;
    let rerunError = "";
    try {
      await applyMigrations(db, (f) => /^01[0-2]_/.test(f));
    } catch (err) {
      rerun = false;
      rerunError = err instanceof Error ? err.message : String(err);
    }
    t.check("re-applying migrations 010-012 is a no-op (they are idempotent)", rerun, rerunError);

    // -----------------------------------------------------------------
    console.log("retry backoff (pure)");
    t.check("doubles each attempt from the base", [1, 2, 3, 4].map((a) => retryDelaySec(a, 30)).join() === "30,60,120,240");
    t.check("is capped", retryDelaySec(20, 30, 3600) === 3600);
    t.check("attempt 0 is not negative or NaN", retryDelaySec(0, 30) === 30);
    t.check("a zero base retries immediately", retryDelaySec(3, 0) === 0);

    // -----------------------------------------------------------------
    console.log("queue: enqueue and dedupe");
    const q = new WorkQueue(query);
    const id1 = await q.enqueue("demo", { a: 1, nested: { list: [1, 2, 3], s: "é日本" } });
    t.check("enqueue returns an id", typeof id1 === "number" && id1 > 0);
    t.check("stats count it as queued", (await q.stats()).queued === 1);

    const dk1 = await q.enqueue("dedupe", { n: 1 }, { dedupeKey: "k" });
    t.check("first job with a dedupeKey is accepted", dk1 !== null);
    t.check("same (kind, dedupeKey) while queued is a no-op → null", (await q.enqueue("dedupe", { n: 2 }, { dedupeKey: "k" })) === null);
    t.check("same key under a different kind is allowed", (await q.enqueue("other-kind", {}, { dedupeKey: "k" })) !== null);
    t.check("jobs with no dedupeKey never dedupe", (await q.enqueue("plain", {})) !== null && (await q.enqueue("plain", {})) !== null);
    const claimedDk = await q.claim("w", ["dedupe"]);
    t.check("(claimed) the deduped job is running", claimedDk?.id === dk1);
    t.check("…and still blocks a duplicate while RUNNING", (await q.enqueue("dedupe", {}, { dedupeKey: "k" })) === null);
    await q.complete(claimedDk!, "w");
    t.check("…but once done, the same key can be enqueued again", (await q.enqueue("dedupe", {}, { dedupeKey: "k" })) !== null);

    // -----------------------------------------------------------------
    console.log("queue: claim");
    await db.exec("delete from work_queue");
    t.check("an empty queue claims nothing", (await q.claim("w", ["x"])) === null);
    t.check("an empty kinds list claims nothing", (await q.claim("w", [])) === null);

    const low = (await q.enqueue("c", { n: "low" }, { priority: 0 }))!;
    const high = (await q.enqueue("c", { n: "high" }, { priority: 5 }))!;
    const low2 = (await q.enqueue("c", { n: "low2" }, { priority: 0 }))!;
    const future = (await q.enqueue("c", { n: "future" }, { priority: 99, runAfter: new Date(Date.now() + 3_600_000) }))!;
    const wrongKind = (await q.enqueue("zzz", { n: "zzz" }, { priority: 100 }))!;

    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const j = await q.claim("w1", ["c"]);
      if (j) order.push(j.id);
    }
    t.check("claims by priority, then age: high, low, low2", JSON.stringify(order.slice(0, 3)) === JSON.stringify([high, low, low2]), `got ${order}`);
    t.check("a job scheduled in the future is not claimable", !order.includes(future) && order.length === 3);
    t.check("a job of a kind the worker doesn't handle is left alone", (await query(`select status from work_queue where id = $1`, [wrongKind]))[0].status === "queued");

    const rows = await query(`select attempts, locked_by, status from work_queue where id = $1`, [high]);
    t.check("claiming increments attempts and records the worker", rows[0].attempts === 1 && rows[0].locked_by === "w1" && rows[0].status === "running");

    await db.exec("delete from work_queue");
    const payload = { a: 1, nested: { list: [1, 2, 3], s: "é日本" }, nothing: null };
    await q.enqueue("p", payload);
    const pj = await q.claim("w", ["p"]);
    t.check("payload round-trips (nested, unicode, null)", canon(pj?.payload) === canon(payload), canon(pj?.payload));
    t.check("the job carries attempts and maxAttempts", pj?.attempts === 1 && pj?.maxAttempts === 3);

    // -----------------------------------------------------------------
    console.log("queue: complete, touch, fail");
    await db.exec("delete from work_queue");
    await q.enqueue("d", {});
    const dj = (await q.claim("wA", ["d"]))!;
    t.check("touch succeeds for the holder", await q.touch(dj, "wA"));
    t.check("touch fails for another worker", !(await q.touch(dj, "wB")));
    t.check("another worker cannot complete it", !(await q.complete(dj, "wB", { x: 1 })));
    t.check("…nor fail it", (await q.fail(dj, "wB", new Error("no"))) === "lost");
    t.check("the holder completes it, storing the result", await q.complete(dj, "wA", { out: [1, 2] }));
    const done = (await query(`select status, result, locked_by, finished_at from work_queue where id = $1`, [dj.id]))[0];
    t.check("done: result stored, lock cleared, finished_at set", done.status === "done" && canon(done.result) === '{"out":[1,2]}' && done.locked_by === null && done.finished_at !== null);
    t.check("completing twice is refused", !(await q.complete(dj, "wA")));
    t.check("touching a finished job fails", !(await q.touch(dj, "wA")));

    await q.enqueue("f", {}, { maxAttempts: 3 });
    let fj = (await q.claim("w", ["f"]))!;
    t.check("attempt 1 fails → retry", (await q.fail(fj, "w", new Error("boom-1"), 30)) === "retry");
    let frow = (await query(`select status, last_error, run_after > now() as delayed, locked_by from work_queue where id = $1`, [fj.id]))[0];
    t.check("…back to queued, error kept, delayed, unlocked", frow.status === "queued" && String(frow.last_error).includes("boom-1") && frow.delayed === true && frow.locked_by === null);
    t.check("…and NOT claimable during the backoff", (await q.claim("w", ["f"])) === null);
    await db.exec(`update work_queue set run_after = now() - interval '1 second' where id = ${fj.id}`);
    fj = (await q.claim("w", ["f"]))!;
    t.check("…claimable once the delay has passed, attempts=2", fj.attempts === 2);
    t.check("attempt 2 fails → retry", (await q.fail(fj, "w", new Error("boom-2"), 0)) === "retry");
    fj = (await q.claim("w", ["f"]))!;
    t.check("a zero base retries at once, attempts=3", fj.attempts === 3);
    t.check("attempt 3 of 3 fails → failed (dead letter)", (await q.fail(fj, "w", new Error("boom-3"), 0)) === "failed");
    frow = (await query(`select status, last_error, finished_at, attempts from work_queue where id = $1`, [fj.id]))[0];
    t.check("…kept with its last error and finished_at", frow.status === "failed" && String(frow.last_error).includes("boom-3") && frow.finished_at !== null && frow.attempts === 3);
    t.check("…and never claimed again", (await q.claim("w", ["f"])) === null);
    await q.enqueue("f", {});
    const long = (await q.claim("w", ["f"]))!;
    await q.fail(long, "w", new Error("x".repeat(5000)), 0);
    t.check("a huge error message is truncated", String((await query(`select last_error from work_queue where id = $1`, [long.id]))[0].last_error).length <= 2000);

    // -----------------------------------------------------------------
    console.log("queue: stale lock reclaim");
    await db.exec("delete from work_queue");
    await q.enqueue("r", { n: "fresh" });
    await q.enqueue("r", { n: "stale" });
    await q.enqueue("r", { n: "stale-exhausted" }, { maxAttempts: 1 });
    const claimed: QueueJob[] = [];
    for (let i = 0; i < 3; i++) claimed.push((await q.claim("dead-worker", ["r"]))!);
    const byN = (n: string) => claimed.find((c) => (c.payload as { n: string }).n === n)!;
    await db.exec(`update work_queue set locked_at = now() - interval '2 hours' where id in (${byN("stale").id}, ${byN("stale-exhausted").id})`);
    t.check("reclaims exactly the stale locks", (await q.reclaimStale(1800)) === 2);
    const st = async (n: string) => (await query(`select status, last_error, locked_by from work_queue where id = $1`, [byN(n).id]))[0];
    t.check("a fresh lock is left running", (await st("fresh")).status === "running");
    t.check("a stale job with attempts left goes back to queued, unlocked", (await st("stale")).status === "queued" && (await st("stale")).locked_by === null);
    t.check("a stale job out of attempts goes to failed", (await st("stale-exhausted")).status === "failed" && String((await st("stale-exhausted")).last_error).includes("expired"));
    t.check("the dead worker's late complete is refused (lock was reclaimed)", !(await q.complete(byN("stale"), "dead-worker", "late")));
    t.check("a reclaimed job is claimable by another worker", (await q.claim("new-worker", ["r"]))?.id === byN("stale").id);

    // -----------------------------------------------------------------
    console.log("worker: runOnce");
    await db.exec("delete from work_queue");
    const log: string[] = [];
    const base = { queue: q, workerId: "wk", retryBaseSec: 0, log: (m: string) => log.push(m) };
    t.check("nothing runnable → false", (await runOnce({ ...base, handlers: { ok: async () => 1 } })) === false);

    await q.enqueue("ok", { v: 7 });
    t.check("runs a job → true", (await runOnce({ ...base, handlers: { ok: async (j) => ({ echoed: (j.payload as { v: number }).v }) } })) === true);
    t.check("…and stores the handler's result", canon((await query(`select result from work_queue where kind = 'ok'`))[0].result) === '{"echoed":7}');

    await q.enqueue("bad", {});
    let calls = 0;
    const bad = { bad: async () => { calls++; throw new Error("handler exploded"); } };
    await runOnce({ ...base, handlers: bad });
    t.check("a throwing handler does not throw out of runOnce", true);
    t.check("…the job is retried with its error recorded", (await query(`select status, last_error from work_queue where kind = 'bad'`))[0].status === "queued");
    await runOnce({ ...base, handlers: bad });
    await runOnce({ ...base, handlers: bad });
    const badRow = (await query(`select status, attempts, last_error from work_queue where kind = 'bad'`))[0];
    t.check("…and after max attempts it is failed, having run exactly 3 times", badRow.status === "failed" && badRow.attempts === 3 && calls === 3 && String(badRow.last_error).includes("handler exploded"));
    t.check("failures are logged", log.some((l) => /failed → failed/.test(l)));

    await q.enqueue("orphan", {});
    await runOnce({ ...base, handlers: { ok: async () => 1 } });
    t.check("a job with no handler is never claimed", (await query(`select status from work_queue where kind = 'orphan'`))[0].status === "queued");

    await q.enqueue("lostlock", {});
    await runOnce({
      ...base,
      handlers: {
        lostlock: async (j) => {
          // Simulate the lock expiring and another worker taking the job mid-run.
          await query(`update work_queue set locked_by = 'someone-else' where id = $1`, [j.id]);
          return "stale result";
        },
      },
    });
    const lost = (await query(`select status, result, locked_by from work_queue where kind = 'lostlock'`))[0];
    t.check("a worker that lost its lock cannot overwrite the job", lost.status === "running" && lost.result === null && lost.locked_by === "someone-else");
    t.check("…and says so in the log", log.some((l) => /lock had been reclaimed/.test(l)));

    // -----------------------------------------------------------------
    console.log("worker: runWorker");
    await db.exec("delete from work_queue");
    for (let i = 0; i < 6; i++) await q.enqueue("w", { i });
    const seen: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const controller = new AbortController();
    const workerRun = runWorker({
      queue: q,
      workerId: "loop",
      concurrency: 2,
      pollMs: 10,
      retryBaseSec: 0,
      signal: controller.signal,
      handlers: {
        w: async (j) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(30);
          seen.push((j.payload as { i: number }).i);
          inFlight--;
          if (seen.length === 6) controller.abort();
        },
      },
    });
    await workerRun;
    t.check("processes every job exactly once", JSON.stringify([...seen].sort()) === "[0,1,2,3,4,5]", `saw ${seen}`);
    t.check("respects concurrency (2 in flight, never more)", maxInFlight === 2, `max ${maxInFlight}`);
    t.check("all rows are done", (await q.stats()).done >= 6);

    await q.enqueue("slow", {});
    let slowFinished = false;
    const stop = new AbortController();
    const slowRun = runWorker({
      queue: q,
      workerId: "graceful",
      pollMs: 10,
      signal: stop.signal,
      handlers: {
        slow: async () => {
          setTimeout(() => stop.abort(), 20); // ask it to stop while the job is running
          await sleep(150);
          slowFinished = true;
        },
      },
    });
    await slowRun;
    t.check("a stop request lets the in-flight job finish before returning", slowFinished);
    t.check("…and the job is recorded done", (await query(`select status from work_queue where kind = 'slow'`))[0].status === "done");

    console.log("worker: heartbeat keeps a long job's lock alive");
    await q.enqueue("hb", {});
    let reclaimedMidRun = -1;
    await runOnce({
      queue: q,
      workerId: "hb-worker",
      lockTimeoutSec: 3, // heartbeat every 1 s
      handlers: {
        hb: async () => {
          await sleep(2200);
          // The lock is >2 s old unless the heartbeat refreshed it.
          reclaimedMidRun = await q.reclaimStale(2);
          await sleep(200);
        },
      },
    });
    t.check("a slow job is not reclaimed while its heartbeat is beating", reclaimedMidRun === 0, `reclaimed ${reclaimedMidRun}`);
    t.check("…and completes normally", (await query(`select status from work_queue where kind = 'hb'`))[0].status === "done");

    // -----------------------------------------------------------------
    console.log("stores: videos");
    const user = (await query(`insert into users (email, email_norm, password_hash) values ('a@x.com', 'a@x.com', 'h') returning id`))[0].id as string;
    const vid = await insertVideo(query, { ownerId: user, relation: "own", platform: "instagram", platformVideoId: "IG1", url: "https://example.com/r/1", postedAt: new Date("2026-01-02T03:04:05Z") });
    const v = await getVideo(query, vid);
    t.check("insert + get round-trips", v?.ownerId === user && v.relation === "own" && v.mediaKey === null && v.contentHash === null);
    t.check("a missing video is null", (await getVideo(query, "00000000-0000-0000-0000-000000000000")) === null);
    let dup = false;
    try {
      await insertVideo(query, { ownerId: user, relation: "own", platform: "instagram", platformVideoId: "IG1" });
    } catch {
      dup = true;
    }
    t.check("the same platform video for the same owner is refused", dup);
    t.check("…but two videos with no platform id are fine", (await insertVideo(query, { ownerId: user, relation: "own" })) !== (await insertVideo(query, { ownerId: user, relation: "own" })));
    let badRel = false;
    try {
      await insertVideo(query, { ownerId: user, relation: "stolen" as never });
    } catch {
      badRel = true;
    }
    t.check("an unknown relation is refused", badRel);
    await query(`insert into video_metrics (video_id, views, likes) values ($1, 100, 5), ($1, 250, 9)`, [vid]);
    t.check("metrics attach to a video", Number((await query(`select count(*)::int as n from video_metrics where video_id = $1`, [vid]))[0].n) === 2);
    await query(`delete from videos where id = $1`, [vid]);
    t.check("deleting a video cascades to its metrics", Number((await query(`select count(*)::int as n from video_metrics where video_id = $1`, [vid]))[0].n) === 0);

    // -----------------------------------------------------------------
    console.log("stores: analyses");
    const fixture = path.join(scratch, "punch.mp4");
    makePunchInVideo(fixture);
    const hash = await hashFile(fixture);
    const result = await analyzeVideoFile(fixture, { transcript: false, captions: false, contentHash: hash });
    t.check("no analysis before saving", (await getAnalysis(query, hash, ANALYZER_VERSION)) === null);
    await saveAnalysis(query, hash, result);
    const back = await getAnalysis(query, hash, ANALYZER_VERSION);
    t.check("an analysis round-trips through jsonb intact", canon(back?.analysis) === canon(result.analysis));
    t.check("…and so do its features", canon(back?.features) === canon(result.features));
    t.check("a different analyzer version is a miss", (await getAnalysis(query, hash, "some-older-version")) === null);
    t.check("a different content hash is a miss", (await getAnalysis(query, "0".repeat(64), ANALYZER_VERSION)) === null);
    const vecText = String((await query(`select style_vec::text as v from video_analyses where content_hash = $1`, [hash]))[0].v);
    const vec = JSON.parse(vecText) as number[];
    t.check(`the stored style_vec is a ${STYLE_DIM_COUNT}-wide vector literal`, Array.isArray(vec) && vec.length === STYLE_DIM_COUNT && vec.every(Number.isFinite));
    await saveAnalysis(query, hash, { ...result, analysis: { ...result.analysis, warnings: ["upserted"] } });
    t.check("re-saving the same (hash, version) replaces the row", Number((await query(`select count(*)::int as n from video_analyses where content_hash = $1`, [hash]))[0].n) === 1 && (await getAnalysis(query, hash, ANALYZER_VERSION))?.analysis.warnings[0] === "upserted");
    await db.exec(`update video_analyses set analysis = '{"junk": true}'::jsonb`);
    await t.rejects("a row that no longer matches the schema fails loudly on read", () => getAnalysis(query, hash, ANALYZER_VERSION));
    await t.rejects("saving a malformed analysis is refused", () => saveAnalysis(query, hash, { ...result, analysis: { ...result.analysis, media: { ...result.analysis.media, durationSec: -1 } } }));

    // -----------------------------------------------------------------
    console.log("stores: style specs");
    const spec = neutralStyleSpec({ kind: "self", ref: user });
    const sid = await saveStyleSpec(query, { ownerId: user, spec });
    const got = await getStyleSpec(query, sid);
    t.check("a spec round-trips", canon(got?.spec) === canon(spec) && got?.ownerId === user && got?.visibility === "private");
    const sRow = (await query(`select spec, embedding::text as e, source_kind, source_ref from style_specs where id = $1`, [sid]))[0];
    t.check("the embedding is a full-width vector literal in its own column", (JSON.parse(String(sRow.e)) as number[]).length === STYLE_DIM_COUNT);
    t.check("the jsonb never carries the embedding (no drift possible)", !("embedding" in (sRow.spec as object)));
    t.check("source kind/ref are lifted into columns", sRow.source_kind === "self" && sRow.source_ref === user);
    const lib = await saveStyleSpec(query, { ownerId: null, spec: { ...spec, source: { kind: "template", ref: "tpl-1" } }, visibility: "library" });
    t.check("a library spec needs no owner", (await getStyleSpec(query, lib))?.ownerId === null);
    await t.rejects("an invalid spec is refused, naming the field", () => saveStyleSpec(query, { ownerId: user, spec: { ...spec, camera: { punchInRate: 3, zoomScale: 1.2 } } }), /punchInRate/);
    t.check("…and nothing was inserted", Number((await query(`select count(*)::int as n from style_specs`))[0].n) === 2);
    let badVis = false;
    try {
      await query(`insert into style_specs (source_kind, spec, embedding, visibility) values ('self', '{}'::jsonb, '[]'::vector, 'world')`);
    } catch {
      badVis = true;
    }
    t.check("an unknown visibility is refused by the database", badVis);
    t.check("a missing spec is null", (await getStyleSpec(query, "00000000-0000-0000-0000-000000000000")) === null);
    await query(`delete from users where id = $1`, [user]);
    t.check("deleting the owner cascades to their specs but not library specs", Number((await query(`select count(*)::int as n from style_specs`))[0].n) === 1);

    // -----------------------------------------------------------------
    console.log("handler: analyze job");
    await db.exec(`update video_analyses set analysis = analysis`); // (no-op, keeps table)
    await db.exec("delete from video_analyses");
    await db.exec("delete from work_queue");
    const owner = (await query(`insert into users (email, email_norm, password_hash) values ('b@x.com', 'b@x.com', 'h') returning id`))[0].id as string;
    const storage = new LocalStorage(path.join(scratch, "storage"));
    const handlerDeps = { query, storage, analyzeOptions: { transcript: false, captions: false } as const };
    const handler = createAnalyzeHandler(handlerDeps);
    const key = videoKey(hash, "mp4");
    await storage.putFile(key, fixture);
    const asJob = (payload: unknown): QueueJob => ({ id: 1, kind: "analyze", payload, attempts: 1, maxAttempts: 3 });

    const own = await insertVideo(query, { ownerId: owner, relation: "own", mediaKey: key });
    const r1 = (await handler(asJob({ videoId: own }))) as { cached: boolean; contentHash: string };
    t.check("first run analyzes (not cached)", r1.cached === false && r1.contentHash === hash);
    const ownRow = await getVideo(query, own);
    t.check("…hashes the media and records its content hash and duration", ownRow?.contentHash === hash && Math.abs((ownRow?.durationSec ?? 0) - 8) < 0.1);
    t.check("…and stores exactly one analysis", Number((await query(`select count(*)::int as n from video_analyses`))[0].n) === 1);
    t.check("an OWN video's media is kept", await storage.exists(key) && ownRow?.mediaKey === key);

    const before = String((await query(`select created_at::text as c from video_analyses`))[0].c);
    const r2 = (await handler(asJob({ videoId: own }))) as { cached: boolean };
    t.check("running it again is a cache hit (idempotent)", r2.cached === true);
    t.check("…without rewriting the analysis", String((await query(`select created_at::text as c from video_analyses`))[0].c) === before);

    const refKey = "videos/ab/reference-copy.mp4";
    await storage.putFile(refKey, fixture);
    const ref = await insertVideo(query, { ownerId: owner, relation: "reference", mediaKey: refKey });
    const r3 = (await handler(asJob({ videoId: ref }))) as { cached: boolean };
    t.check("the same bytes under another video row are a cache hit", r3.cached === true);
    t.check("a REFERENCE video's media is deleted after analysis", !(await storage.exists(refKey)));
    t.check("…and its media_key is cleared", (await getVideo(query, ref))?.mediaKey === null);
    t.check("…while the derived analysis remains", (await getAnalysis(query, hash, ANALYZER_VERSION)) !== null);
    await t.rejects("re-running on the now media-less reference fails clearly", () => handler(asJob({ videoId: ref })), /no media/);

    await t.rejects("an unknown video is refused", () => handler(asJob({ videoId: "00000000-0000-0000-0000-000000000000" })), /does not exist/);
    await t.rejects("a payload without a videoId is refused", () => handler(asJob({})), /videoId/);
    await t.rejects("a null payload is refused", () => handler(asJob(null)), /videoId/);
    const missingMedia = await insertVideo(query, { ownerId: owner, relation: "own", mediaKey: "videos/ab/gone.mp4" });
    await t.rejects("a key with no stored object is refused", () => handler(asJob({ videoId: missingMedia })), /no object/);

    console.log("handler: through the queue");
    const own2 = await insertVideo(query, { ownerId: owner, relation: "own", mediaKey: key });
    const jobId = await enqueueAnalysis(q, own2);
    t.check("enqueueAnalysis queues a job", jobId !== null);
    t.check("a second request while queued is deduped", (await enqueueAnalysis(q, own2)) === null);
    t.check("dedupe key includes the analyzer version", String((await query(`select dedupe_key from work_queue where id = $1`, [jobId]))[0].dedupe_key) === `${own2}:${ANALYZER_VERSION}`);
    await runOnce({ queue: q, workerId: "e2e", handlers: createAnalysisHandlers(handlerDeps), retryBaseSec: 0 });
    const jr = (await query(`select status, result from work_queue where id = $1`, [jobId]))[0];
    t.check("a worker processes it to done with the handler's result", jr.status === "done" && (jr.result as { cached: boolean }).cached === true);
    t.check("after it finishes, the same video can be enqueued again", (await enqueueAnalysis(q, own2)) !== null);
  } finally {
    await db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  t.finish("db");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

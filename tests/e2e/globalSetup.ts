import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_URL, testEnv } from "./env";

/**
 * Starts the queue worker for the run (the web servers are started by
 * playwright.config.ts's `webServer`, which runs before this). The worker has
 * no port to wait on, so it lives here, and the returned function stops it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const worker: ChildProcess = spawn("npm", ["run", "--silent", "worker"], { env: { ...testEnv(), WORKER_POLL_MS: "300" } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let ready = false;
  const onData = (chunk: Buffer) => {
    if (chunk.toString().includes("up; handling")) ready = true;
  };
  worker.stdout?.on("data", onData);
  worker.stderr?.on("data", (c: Buffer) => process.stderr.write(`[worker] ${c}`));

  const deadline = Date.now() + 30_000;
  while (!ready) {
    if (worker.exitCode !== null) throw new Error(`the test worker exited early (${worker.exitCode})`);
    if (Date.now() > deadline) {
      worker.kill("SIGTERM");
      throw new Error("the test worker did not start within 30s");
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  await warmRoutes();

  return async () => {
    removeFixtureJobs();
    worker.kill("SIGTERM");
    await new Promise((resolve) => {
      worker.once("exit", resolve);
      setTimeout(() => {
        worker.kill("SIGKILL");
        resolve(undefined);
      }, 5000).unref();
    });
  };
}

/**
 * The dev server compiles a route the first time it is asked for, and a
 * request that arrives while that is happening can be answered 404. Asking
 * for every route once, as the founder, before the tests start keeps that out
 * of the results. (The proxy answers an anonymous request before the route
 * runs, so this has to be signed in.)
 */
const WARM = [
  "/calendar", "/plan", "/plan/card-draft", "/admin/production", "/admin/review", "/admin/sources", "/videos/card-review/edit", "/dev-tools/task-progress",
  "/api/tasks?slug=acme", "/api/brands/acme/cards/x/video", "/api/brands/acme/cards/x/post", "/api/brands/acme/cards/x", "/api/brands/acme/cards/x/script", "/api/brands/acme/cards/approve-all", "/api/brands/acme/sources",
  "/api/admin/brands/acme/send", "/api/admin/brands/acme/plan", "/api/admin/brands/acme/cards/x/release", "/api/admin/brands/acme/cards/x/estimate",
  "/api/jobs/acme-card-review/regenerate-clip", "/api/jobs/acme-card-review/edl", "/api/jobs/acme-card-review/clip-takes",
];

const warmRoutes = async (): Promise<void> => {
  const login = await fetch(`${APP_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "founder@katalab.test", password: "test-password-123" }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!login.ok || !cookie) throw new Error(`could not sign in to warm the routes (${login.status})`);
  for (const path of WARM) await fetch(`${APP_URL}${path}`, { headers: { cookie }, redirect: "manual" }).catch(() => undefined);
};

/**
 * The stub producer publishes editor jobs outside storage/ (jobs/, artifacts/,
 * public/jobs/, out/). The brands in the fixture (acme, rival, planco) exist
 * only in tests, so anything under those prefixes is test debris. Done here,
 * after the servers have stopped writing, because the test server is started
 * through npm and does not reliably see the signal that stops it.
 */
const removeFixtureJobs = (): void => {
  for (const base of ["jobs", "artifacts", "public/jobs", "out"]) {
    const dir = path.join(process.cwd(), base);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).filter((n) => /^(acme|rival|planco)-/.test(n))) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
};

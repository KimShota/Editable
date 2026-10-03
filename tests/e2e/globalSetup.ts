import { type ChildProcess, spawn } from "node:child_process";
import { testEnv } from "./env";

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

  return async () => {
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

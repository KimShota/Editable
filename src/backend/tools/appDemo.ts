import { spawn, type ChildProcess } from "node:child_process";

/**
 * Runs the app and the queue worker together, for the demo and for local
 * work: the app starts jobs, the worker runs them (plan/ui-ux-full-flow.md
 * §2.4).
 *
 *   npm run app:demo
 *
 * Output from both is prefixed so it can be told apart. Ctrl-C (or either
 * process exiting) stops both. No dependency: two child processes and signal
 * forwarding are all it takes.
 */

const children: { name: string; proc: ChildProcess }[] = [];
let stopping = false;

const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const { proc } of children) proc.kill("SIGTERM");
  // The worker finishes an in-flight job on SIGTERM; give it a moment, then force.
  setTimeout(() => {
    for (const { proc } of children) if (proc.exitCode === null) proc.kill("SIGKILL");
    process.exit(code);
  }, 8000).unref();
  const check = setInterval(() => {
    if (children.every(({ proc }) => proc.exitCode !== null || proc.signalCode !== null)) {
      clearInterval(check);
      process.exit(code);
    }
  }, 200);
};

const run = (name: string, script: string) => {
  const proc = spawn("npm", ["run", "--silent", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  };
  prefix(proc.stdout, process.stdout);
  prefix(proc.stderr, process.stderr);
  proc.on("exit", (code, signal) => {
    if (!stopping) console.error(`[${name}] exited (${signal ?? code}); stopping the other process`);
    stop(code ?? 1);
  });
  children.push({ name, proc });
};

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop(0));

run("app", "app:dev");
run("worker", "worker");

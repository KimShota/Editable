import { spawn } from "node:child_process";
import { repoRoot } from "../pipeline/paths";
import type { OpContext, ProductionOps } from "./deps";
import { PRODUCE_STAGE } from "../queue/stages";

/**
 * Production through the `produce` CLI (production/cli.ts), run as a child
 * process of the worker. See ProductionOps for why. Output is read line by
 * line: a "clip(s) to make" line gives the total, and each "✔ s0 talking"
 * style line is one finished shot.
 */

type Run = { code: number | null; stdout: string; stderrTail: string };

const runProduce = (args: string[], onLine?: (line: string) => void): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "-s", "produce", "--", ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let carry = "";
    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      carry += text;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderrTail }));
  });

/** The CLI's own message for a failure, not a stack trace. */
const lastLine = (text: string): string => text.trim().split("\n").filter(Boolean).pop() ?? "production failed";

const mustSucceed = (run: Run, what: string): Run => {
  if (run.code !== 0) throw new Error(`${what}: ${lastLine(run.stderrTail || run.stdout)}`);
  return run;
};

const cardArgs = (slug: string, cardId: string): string[] => ["--brand", slug, "--card", cardId];

export const cliProduction = (): ProductionOps => ({
  estimate: async (_ctx, slug, cardId) => {
    // The timeline (and so the estimate) needs the voiced script, which is
    // cheap and cached for the real run.
    mustSucceed(await runProduce(["voice", ...cardArgs(slug, cardId)]), "voice");
    const { stdout } = mustSucceed(await runProduce(["clips", ...cardArgs(slug, cardId), "--dry"]), "estimate");
    const m = /total ≈ \$([\d.]+)(?:, at most \$([\d.]+))?/.exec(stdout);
    if (!m) throw new Error("the estimate could not be read from the production output");
    return { usd: Number(m[1]), maxUsd: Number(m[2] ?? m[1]) };
  },

  produce: async (ctx: OpContext, slug, cardId) => {
    const flagged = new Set<string>();
    ctx.report?.({ stage: PRODUCE_STAGE.voice });
    mustSucceed(await runProduce(["voice", ...cardArgs(slug, cardId)]), "voice");

    let total = 0;
    let done = 0;
    ctx.report?.({ stage: PRODUCE_STAGE.clips });
    mustSucceed(
      await runProduce(["clips", ...cardArgs(slug, cardId)], (line) => {
        const count = /^(\d+) clip\(s\) to make/.exec(line);
        if (count) {
          total = Number(count[1]);
          ctx.report?.({ stage: PRODUCE_STAGE.clips, done, total });
        }
        const shot = /^\s+([✔⚑✘]) (\S+) \w+\s*$/.exec(line);
        if (shot) {
          done++;
          if (shot[1] === "⚑") flagged.add(shot[2]);
          ctx.report?.({ stage: PRODUCE_STAGE.clips, done, total: Math.max(total, done), message: shot[2] });
        }
      }),
      "clips",
    );

    ctx.report?.({ stage: PRODUCE_STAGE.assemble });
    mustSucceed(await runProduce(["render", ...cardArgs(slug, cardId)]), "render");
    return { flagged: [...flagged] };
  },

  regenEstimate: async (jobId, clipId, planId) => {
    const { stdout } = mustSucceed(await runProduce(["regen-clip", "--job", jobId, "--clip", clipId, ...(planId ? ["--plan", planId] : []), "--dry"]), "estimate");
    const usd = /estimate_usd ([\d.]+)/.exec(stdout)?.[1];
    if (!usd) throw new Error("the estimate could not be read from the production output");
    return { usd: Number(usd) };
  },

  regenerate: async (ctx, jobId, clipId, planId) => {
    ctx.report?.({ stage: "Generating a new take" });
    mustSucceed(await runProduce(["regen-clip", "--job", jobId, "--clip", clipId, ...(planId ? ["--plan", planId] : [])]), "regenerate");
  },
});

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../lib/jobs";
import { repoRoot, artifactsDir, outDir } from "@backend/pipeline/paths";

/**
 * Rendering shells out to `npx remotion render` under the hood (see
 * pipeline/render.ts), which can take tens of seconds. Running it via the
 * synchronous CLI path in-process would block the whole Next.js server for
 * every request while a render is in flight, so this spawns the pipeline's
 * render stage as a real child process and reports progress through a
 * status file the client polls — the same "background job + poll" shape
 * described in the product plan.
 */

type RenderStatus =
  | { status: "idle" }
  | { status: "rendering"; startedAt: string; percent: number }
  | { status: "done"; startedAt: string; finishedAt: string; outUrl: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const statusPath = (jobId: string) => path.join(artifactsDir(jobId), "render-status.json");
const readStatus = (jobId: string): RenderStatus | null =>
  fs.existsSync(statusPath(jobId))
    ? JSON.parse(fs.readFileSync(statusPath(jobId), "utf8"))
    : null;
const writeStatus = (jobId: string, status: RenderStatus): void =>
  fs.writeFileSync(statusPath(jobId), JSON.stringify(status, null, 2));

/**
 * `remotion render`'s CLI progress ("Bundling N%", "Rendered N/TOTAL",
 * "Encoded N/TOTAL") is plain stdout text, not a structured event — this
 * pipeline shells out to that CLI (see pipeline/render.ts) rather than
 * Remotion's programmatic renderMedia()/onProgress API, so parsing the text
 * is the integration point without restructuring how rendering is invoked.
 * The three phases are weighted into one overall percent; each phase is
 * monotonic on its own, and the max() against the running total keeps the
 * combined number from ever ticking backward across a phase boundary.
 */
const BUNDLE_PCT = 8;
const RENDER_PCT = 84;
const ENCODE_PCT = 100 - BUNDLE_PCT - RENDER_PCT;

const parseProgressPercent = (text: string, current: number): number => {
  let percent = current;
  for (const line of text.split("\n")) {
    const bundling = line.match(/Bundling (\d+)%/);
    if (bundling) {
      percent = Math.max(percent, (Number(bundling[1]) / 100) * BUNDLE_PCT);
    }
    const rendered = line.match(/Rendered (\d+)\/(\d+)/);
    if (rendered) {
      percent = Math.max(percent, BUNDLE_PCT + (Number(rendered[1]) / Number(rendered[2])) * RENDER_PCT);
    }
    const encoded = line.match(/Encoded (\d+)\/(\d+)/);
    if (encoded) {
      percent = Math.max(
        percent,
        BUNDLE_PCT + RENDER_PCT + (Number(encoded[1]) / Number(encoded[2])) * ENCODE_PCT,
      );
    }
  }
  return percent;
};

export async function POST(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  if (!fs.existsSync(path.join(artifactsDir(jobId), "edl.json"))) {
    return NextResponse.json({ error: "build the job before rendering" }, { status: 400 });
  }
  const existing = readStatus(jobId);
  if (existing?.status === "rendering") {
    return NextResponse.json(existing, { status: 202 });
  }

  const startedAt = new Date().toISOString();
  let percent = 0;
  writeStatus(jobId, { status: "rendering", startedAt, percent });

  const child = spawn(
    "npm",
    ["run", "pipeline", "--", "--job", jobDir(jobId), "--only", "render"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  child.stdout.on("data", (chunk) => {
    const next = parseProgressPercent(chunk.toString(), percent);
    if (next !== percent) {
      percent = next;
      writeStatus(jobId, { status: "rendering", startedAt, percent });
    }
  });
  child.on("close", (code) => {
    const finishedAt = new Date().toISOString();
    if (code === 0 && fs.existsSync(path.join(outDir, `${jobId}.mp4`))) {
      writeStatus(jobId, { status: "done", startedAt, finishedAt, outUrl: `/api/media/out/${jobId}.mp4` });
    } else {
      writeStatus(jobId, { status: "error", startedAt, finishedAt, error: stderrTail || `render exited with code ${code}` });
    }
  });

  return NextResponse.json({ status: "rendering", startedAt, percent }, { status: 202 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const existing = readStatus(jobId);
  if (existing) return NextResponse.json(existing);

  const rendered = fs.existsSync(path.join(outDir, `${jobId}.mp4`));
  return NextResponse.json(
    rendered
      ? { status: "done", startedAt: "", finishedAt: "", outUrl: `/api/media/out/${jobId}.mp4` }
      : { status: "idle" },
  );
}

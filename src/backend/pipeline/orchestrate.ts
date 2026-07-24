import fs from "node:fs";
import path from "node:path";
import { intake } from "./intake";
import { loadFormat } from "./loader";
import { generate } from "./generate";
import { GeneratorChoice } from "./generation";
import { transcribe } from "./transcribe";
import { correctTranscript } from "./correctTranscript";
import { trim } from "./trim";
import { resolveRoles } from "./resolveRoles";
import { ResolverChoice } from "./resolvers";
import { assemble } from "./assemble";
import { render, stageAssets } from "./render";
import { artifactsDir } from "./paths";
import { Edl } from "./types";
import { EdlSchema } from "./schemas";

/**
 * Programmatic entry points for the same six-stage pipeline `run.ts` drives
 * from the CLI (see run.ts for the --job/--only/--resolver CLI surface).
 * These exist for the app's API routes, which need to call the stages
 * directly (no subprocess) and get results back as values, not console
 * output — so the sequencing is intentionally re-stated here rather than
 * shared, keeping the CLI's argv/--only/logging concerns out of this file.
 *
 * Both entry points also stage assets into public/ (see render.ts) after
 * assembling — not just at render time — so the app's live editor preview
 * (Remotion <Player>, which resolves staticFile() against public/ exactly
 * like Remotion Studio does) has real files to show without a full render.
 */

const writeArtifact = (jobId: string, name: string, data: unknown): void => {
  const dir = artifactsDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
};

/** Runs intake through assemble for a job directory, writing every artifact. Returns the EDL. */
export const buildJob = async (
  jobDir: string,
  jobId: string,
  resolver: ResolverChoice = "auto",
  generator: GeneratorChoice = "auto",
): Promise<Edl> => {
  const intakeFilled = intake(jobDir);
  writeArtifact(jobId, "filled", intakeFilled);
  const format = loadFormat(intakeFilled.formatId);

  // Fills any slot the format marks with a `generation` spec (an insert —
  // never a voice block's own spoken clip) before anything else runs, so
  // transcribe/trim/assemble see an ordinary bound clip either way. A
  // format with no generated slots makes this a no-op. See generate.ts.
  // filled.json on disk stays pure intake output (see generate.ts's
  // applyInserts doc comment) — only inserts.json records what was
  // generated; the merged `filled` below is used in-memory for this run.
  const { filled, inserts } = await generate(format, intakeFilled, generator);
  writeArtifact(jobId, "inserts", inserts);

  const rawTranscript = transcribe(format, filled);
  const transcript = await correctTranscript(filled, rawTranscript, resolver);
  writeArtifact(jobId, "transcript", transcript);

  const trims = await trim(format, filled, transcript, resolver);
  writeArtifact(jobId, "trim", trims);

  const resolved = await resolveRoles(format, transcript, trims, resolver);
  writeArtifact(jobId, "roles", resolved);

  const edl = assemble(format, filled, transcript, trims, resolved);
  writeArtifact(jobId, "edl", edl);
  stageAssets(edl);

  return edl;
};

/** Re-runs only assembly against artifacts already on disk (fast: no whisper/LLM calls). */
export const reassembleJob = async (jobDir: string, jobId: string): Promise<Edl> => {
  const dir = artifactsDir(jobId);
  const readArtifact = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

  const intakeFilled = intake(jobDir); // cheap; picks up any binding/override edits made since build
  writeArtifact(jobId, "filled", intakeFilled);
  const format = loadFormat(intakeFilled.formatId);

  // Fresh intake() has no generated bindings — restore them. Inputs are
  // unchanged (same identity photos/StyleProfile/shot/seed), so this is a
  // cache hit (an ffprobe read, no ffmpeg call), keeping reassemble cheap.
  const { filled, inserts } = await generate(format, intakeFilled, "auto");
  writeArtifact(jobId, "inserts", inserts);

  const transcript = readArtifact("transcript");
  const trims = readArtifact("trim");
  const resolved = readArtifact("roles");

  const edl = assemble(format, filled, transcript, trims, resolved);
  writeArtifact(jobId, "edl", edl);
  stageAssets(edl);
  return edl;
};

/** Renders the job's already-assembled EDL to out/<jobId>.mp4. */
export const renderJob = (jobId: string): string => {
  const dir = artifactsDir(jobId);
  const edl: Edl = JSON.parse(fs.readFileSync(path.join(dir, "edl.json"), "utf8"));
  return render(edl, dir);
};

/**
 * Reads a job's edl.json as the timeline editor's source of truth. If it
 * predates a schema change (e.g. was written before clip ids existed), one
 * reassemble backfills the new fields from scratch — a one-time migration,
 * since reassemble only re-derives from the format/trims/roles, never from
 * hand-made timeline edits.
 */
export const readOrMigrateEdl = async (jobDir: string, jobId: string): Promise<Edl> => {
  const edlPath = path.join(artifactsDir(jobId), "edl.json");
  const raw = JSON.parse(fs.readFileSync(edlPath, "utf8"));
  const parsed = EdlSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return reassembleJob(jobDir, jobId);
};

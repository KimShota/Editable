import fs from "node:fs";
import path from "node:path";
import { intake } from "./intake";
import { loadFormat } from "./loader";
import { generate } from "./generate";
import { GeneratorChoice } from "./generation";
import { transcribe } from "./transcribe";
import { deriveTranscriptAndTrimWithStandalone, splitTake, SplitTakeResult } from "./splitTake";
import { correctTranscript } from "./correctTranscript";
import { trim } from "./trim";
import { replaceBackgrounds } from "./backgroundReplace";
import { resolveRoles } from "./resolveRoles";
import { ResolverChoice } from "./resolvers";
import { assemble } from "./assemble";
import { render, stageAssets } from "./render";
import { runGates } from "./gates";
import { artifactsDir } from "./paths";
import { Edl, FilledFormat, Format, Transcript, TrimPoints } from "./types";
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

/** The persisted split (auto or manually adjusted), for a single-take-mode
 *  format — see splitTake.ts and schemas.ts's speakingTakeSlot doc. Null
 *  before the split step has ever run for this job. */
export const readSplit = (jobId: string): SplitTakeResult | null => {
  const file = path.join(artifactsDir(jobId), "splitTake.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

/** Runs (or re-runs, for "Re-align lines") auto-split fresh from the bound
 *  speaking take, discarding any manual adjustment previously saved. */
export const runSplit = (format: Format, filled: FilledFormat, jobId: string): SplitTakeResult => {
  const slot = format.speakingTakeSlot;
  if (!slot) throw new Error(`runSplit: format "${format.id}" has no speakingTakeSlot`);
  const take = filled.bindings[slot.name];
  if (take?.type !== "file" || take.durationSec === undefined) {
    throw new Error(
      `runSplit: speakingTakeSlot "${slot.name}" is not bound to a file with a known duration`,
    );
  }
  const split = splitTake(format, take.absPath, take.durationSec);
  writeArtifact(jobId, "splitTake", split);
  return split;
};

/** Persists a manually dragged span for one block — re-derived from the
 *  SAME stored whole-take words already on disk, never re-transcribing. */
export const adjustSplit = (
  jobId: string,
  blockId: string,
  srcInSec: number,
  srcOutSec: number,
): SplitTakeResult => {
  const split = readSplit(jobId);
  if (!split) {
    throw new Error(`adjustSplit: no split exists yet for job "${jobId}" — run split first`);
  }
  const next: SplitTakeResult = {
    ...split,
    blocks: split.blocks.map((b) =>
      b.blockId === blockId ? { ...b, srcInSec, srcOutSec, confidence: 1 } : b,
    ),
  };
  writeArtifact(jobId, "splitTake", next);
  return next;
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

  // Single-take mode (speakingTakeSlot set): the split UI (resources
  // wizard Step 3) is the normal path to a good splitTake.json, but if the
  // user skipped straight to build, auto-split now rather than failing —
  // same "never block a build over a skipped manual step" idea a
  // generated slot's own fallback already uses. Otherwise, the ordinary
  // per-block transcribe/trim this pipeline always did.
  let rawTranscript: Transcript;
  let trims: TrimPoints | undefined;
  if (format.speakingTakeSlot) {
    const split = readSplit(jobId) ?? runSplit(format, filled, jobId);
    const derived = await deriveTranscriptAndTrimWithStandalone(format, filled, split, resolver);
    rawTranscript = derived.transcript;
    trims = derived.trim;
  } else {
    rawTranscript = transcribe(format, filled);
  }

  let transcript = await correctTranscript(filled, rawTranscript, resolver);

  if (!trims) {
    trims = await trim(format, filled, transcript, resolver);
  }

  // Blocks flagged backgroundReplace/punchInTailSec (see schemas.ts's
  // BlockSchema doc comment) get their video processed here — after
  // trim/split settles each flagged block's own span, before
  // resolveRoles/assemble, both of which must see the REPLACED
  // bindings/trims/transcript (a new standalone file per block starting
  // at 0, not a sub-span of the shared take — see backgroundReplace.ts's
  // doc comment on why the transcript has to be rebased too).
  const replaced = await replaceBackgrounds(format, filled, trims, transcript);
  const finalFilled = replaced.filled;
  trims = replaced.trims;
  transcript = replaced.transcript;
  writeArtifact(jobId, "transcript", transcript);
  writeArtifact(jobId, "trim", trims);

  const resolved = await resolveRoles(format, transcript, trims, resolver);
  writeArtifact(jobId, "roles", resolved);

  const edl = assemble(format, finalFilled, transcript, trims, resolved);
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

/** Renders the job's already-assembled EDL to out/<jobId>.mp4, then runs
 *  the acceptance gates against the actual export (see gates.ts) — same
 *  "fail loudly rather than ship a broken render silently" contract as
 *  run.ts's CLI render stage. */
export const renderJob = (jobId: string): string => {
  const dir = artifactsDir(jobId);
  const edl: Edl = JSON.parse(fs.readFileSync(path.join(dir, "edl.json"), "utf8"));
  const outPath = render(edl, dir);

  const gateResults = runGates(outPath, edl);
  writeArtifact(jobId, "gates", gateResults);
  const failed = gateResults.filter((r) => r.pass === false);
  if (failed.length > 0) {
    throw new Error(`${failed.length} acceptance gate(s) failed (see artifacts/${jobId}/gates.json) — ${failed.map((r) => r.name).join("; ")}`);
  }
  return outPath;
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

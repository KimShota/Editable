import { runRvmOnStills } from "./rvmStills";

/**
 * Subprocess entry point for rvmStills.ts, invoked by matte.ts's
 * matteFramesBatch exactly the way it invokes matte.swift.
 *
 * The subprocess boundary is load-bearing, not incidental. ONNX Runtime's
 * session create/run are async, but matteFramesBatch is synchronous and
 * sits underneath two synchronous callers that have no business becoming
 * async — intake.ts's checkTalkingHeadFraming (one link in a chain of
 * validation checks) and shotQC.ts's measureGeometry (called inside
 * generatedShots' retry loop). Awaiting through them would force an async
 * refactor across intake and QC for no behavioural gain. Running the async
 * work in a child process instead keeps matteFramesBatch's signature — and
 * every caller above it — exactly as it is.
 *
 * Kept separate from rvmStills.ts so that module stays importable (by the
 * proof tool, and by anything that later wants the in-process async API)
 * without this top-level main() firing on import.
 */

const main = async (): Promise<void> => {
  const [inputDir, outputDir] = process.argv.slice(2);
  if (!inputDir || !outputDir) {
    throw new Error("usage: rvmStillsCli.ts <input_dir> <output_dir>");
  }
  await runRvmOnStills(inputDir, outputDir);
};

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

/**
 * A minimal assertion collector for the repo's tsx check scripts
 * (`npm run test:*`): no test framework, matching selectRobustness.ts and
 * anchorRobustness.ts. Every check runs and is reported; the process exits
 * non-zero if any failed, so a script is usable in CI as-is.
 */

export type Checker = {
  /** Records one check. `detail` is shown on failure (and on pass with -v). */
  check: (name: string, pass: boolean, detail?: string) => void;
  /** Asserts `fn` throws, optionally with a message matching `pattern`. */
  throws: (name: string, fn: () => unknown, pattern?: RegExp) => void;
  /** Same for an async function. */
  rejects: (name: string, fn: () => Promise<unknown>, pattern?: RegExp) => Promise<void>;
  /** Prints a summary and sets the exit code. Call last. */
  finish: (title: string) => void;
};

export const makeChecker = (): Checker => {
  const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
  const record = (name: string, pass: boolean, detail?: string) => {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? "✔" : "✘"} ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  };
  const matches = (err: unknown, pattern?: RegExp) =>
    !pattern || pattern.test(err instanceof Error ? err.message : String(err));

  return {
    check: record,
    throws: (name, fn, pattern) => {
      try {
        fn();
        record(name, false, "expected a throw, got none");
      } catch (err) {
        record(name, matches(err, pattern), `threw "${err instanceof Error ? err.message : err}", expected ${pattern}`);
      }
    },
    rejects: async (name, fn, pattern) => {
      try {
        await fn();
        record(name, false, "expected a rejection, got none");
      } catch (err) {
        record(name, matches(err, pattern), `rejected with "${err instanceof Error ? err.message : err}", expected ${pattern}`);
      }
    },
    finish: (title) => {
      const failed = results.filter((r) => !r.pass);
      console.log(`\n${title}: ${results.length - failed.length}/${results.length} passed`);
      if (failed.length > 0) {
        console.log(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join("\n")}`);
        process.exitCode = 1;
      }
    },
  };
};

/** True when |a - b| <= tol. */
export const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

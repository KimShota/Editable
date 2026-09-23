import { decideKeep, Utterance } from "../select";
import { LiteralAnchor, Word } from "../types";

/**
 * Selection robustness probe — the question this answers is "does
 * select.ts's decideKeep() correctly separate a retake/false-start/aside
 * from genuinely distinct content", tested against hand-authored word
 * lists standing in for "arbitrary raw footage." No ffmpeg, no whisper,
 * no file I/O: decideKeep() is a pure function of (utterances,
 * instructions, anchors, resolver) once the utterances already exist, so
 * this drives it directly — same "probe the REAL decision function, no
 * reimplementation to drift out of sync" idea as authoring's own
 * anchorRobustness.ts, which this file's structure and report format
 * mirror closely.
 *
 *   npm run test:select
 *
 * Every scenario runs with resolver=null (heuristic only) — the LLM path
 * is a confidence-gated override on top of the same heuristic verdicts
 * this checks, not a separate decision path worth re-testing here (its
 * prompt is exercised for real by the actual `select` stage against real
 * footage instead).
 */

const WORD_SEC = 0.32;
const GAP_SEC = 0.1;

/** Turns a sentence into a Word[] with synthetic timestamps at a fixed
 *  pace, continuing from `startAt`. */
const wordsFromText = (text: string, startAt: number): { words: Word[]; endAt: number } => {
  let t = startAt;
  const words: Word[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    words.push({ text: raw, startSec: t, endSec: t + WORD_SEC });
    t += WORD_SEC + GAP_SEC;
  }
  return { words, endAt: t };
};

/** Builds a scenario's utterance list from a list of sentences, each its
 *  own utterance, separated by a real between-utterance gap. `fileIdx`
 *  defaults to 0 (one file, several internal utterances — the "one clip
 *  with retakes inside it" filming style); pass explicit indices to
 *  simulate "several separate files per block" instead. */
const UTTERANCE_BREAK_SEC = 1.0;
const buildUtterances = (
  sentences: { text: string; fileIdx?: number }[],
): Utterance[] => {
  const perFileCursor = new Map<number, number>();
  const perFileIndex = new Map<number, number>();
  return sentences.map((s, i) => {
    const fileIdx = s.fileIdx ?? 0;
    const startAt = perFileCursor.get(fileIdx) ?? 0;
    const { words, endAt } = wordsFromText(s.text, startAt);
    perFileCursor.set(fileIdx, endAt + UTTERANCE_BREAK_SEC);
    const fileUtteranceIndex = perFileIndex.get(fileIdx) ?? 0;
    perFileIndex.set(fileIdx, fileUtteranceIndex + 1);
    return {
      id: `scenario#${i}`,
      blockId: "test-block",
      fileIdx,
      fileUtteranceIndex,
      srcInSec: words[0].startSec,
      srcOutSec: words[words.length - 1].endSec,
      words,
    };
  });
};

// ---------------------------------------------------------------------------
// Reporting — same shape as authoring/tools/anchorRobustness.ts
// ---------------------------------------------------------------------------

type CheckResult = { name: string; pass: boolean; detail: string };
const checks: CheckResult[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

const kept = (decisions: Awaited<ReturnType<typeof decideKeep>>): string[] =>
  [...decisions.entries()].filter(([, d]) => d.keep).map(([id]) => id);

const main = async () => {
  console.log("selection robustness probe\n");

  // --- A line said twice: keep the second (later wins) ---
  {
    const utterances = buildUtterances([
      { text: "Just dump all of your raw files in and talk to it like a friend" },
      { text: "Just dump all of your raw files in and talk to it like a friend" },
    ]);
    const decisions = await decideKeep(utterances, "explain the first step", [], null);
    check(
      "retake: line said twice → only the second survives",
      kept(decisions).length === 1 && kept(decisions)[0] === utterances[1].id,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // --- A false start, abandoned, then completed later ---
  {
    const utterances = buildUtterances([
      { text: "Just dump your raw" },
      { text: "Just dump your raw files in and wait ten seconds" },
    ]);
    const decisions = await decideKeep(utterances, "explain the first step", [], null);
    check(
      "false start: abandoned prefix dropped, completed version kept",
      kept(decisions).length === 1 && kept(decisions)[0] === utterances[1].id,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // --- Filler/aside between two DIFFERENT (not retakes of each other)
  // real lines — the aside is dropped, both real lines survive ---
  {
    const utterances = buildUtterances([
      { text: "It cooks up a polished video for you in seconds" },
      { text: "okay um so yeah right" },
      { text: "By the way this tool is totally free to use" },
    ]);
    const decisions = await decideKeep(utterances, "explain the payoff, then the CTA", [], null);
    check(
      "filler aside between two distinct real lines is dropped",
      decisions.get(utterances[1].id)!.keep === false,
      `middle utterance keep=${decisions.get(utterances[1].id)!.keep}, reason="${decisions.get(utterances[1].id)!.reason}"`,
    );
    check(
      "filler scenario: the distinct real line before and after the aside both survive",
      decisions.get(utterances[0].id)!.keep === true && decisions.get(utterances[2].id)!.keep === true,
      `first=${decisions.get(utterances[0].id)!.keep}, last=${decisions.get(utterances[2].id)!.keep}`,
    );
  }

  // --- Two SEPARATE FILES that are different PARTS of one line — both kept ---
  {
    const utterances = buildUtterances([
      { text: "Writing emails", fileIdx: 0 },
      { text: "I use Claude", fileIdx: 1 },
    ]);
    const decisions = await decideKeep(utterances, "say the task, then the tool", [], null);
    check(
      "two files, two distinct halves of one line → both kept",
      kept(decisions).length === 2,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // --- Two separate files that are RETAKES of each other → keep the later ---
  {
    const utterances = buildUtterances([
      { text: "I just made a website called example dot com", fileIdx: 0 },
      { text: "I just made a website called example dot com", fileIdx: 1 },
    ]);
    const decisions = await decideKeep(utterances, "introduce the product", [], null);
    check(
      "two files, same line said twice → only the later file's take survives",
      kept(decisions).length === 1 && kept(decisions)[0] === utterances[1].id,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // --- Anchor guard: a literal anchor phrase only in the take the retake
  // heuristic would otherwise drop must still survive ---
  {
    const anchor: LiteralAnchor = {
      id: "marker",
      kind: "literal",
      phrases: ["so just comment"],
      capture: true,
      fallback: { anchor: "blockStart", offsetSec: 0 },
    };
    const utterances = buildUtterances([
      { text: "so just comment editor and I will send you the link" },
      { text: "editor and I will send you the link" },
    ]);
    const decisions = await decideKeep(utterances, "ask for a comment", [anchor], null);
    check(
      "anchor guard: the utterance holding the marker phrase is protected",
      decisions.get(utterances[0].id)!.keep === true,
      `first (anchor-bearing) keep=${decisions.get(utterances[0].id)!.keep}, reason="${decisions.get(utterances[0].id)!.reason}"`,
    );
  }

  // --- "Bye" x4 → exactly one survives ---
  {
    const utterances = buildUtterances([
      { text: "Bye" },
      { text: "Bye" },
      { text: "Bye" },
      { text: "Bye" },
    ]);
    const decisions = await decideKeep(utterances, "sign off", [], null);
    check(
      "repeated one-word sign-off (Bye x4): collapses to exactly one",
      kept(decisions).length === 1,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // --- Never drop every utterance in a block ---
  {
    const utterances = buildUtterances([{ text: "um okay" }, { text: "so um" }]);
    const decisions = await decideKeep(utterances, "say something", [], null);
    check(
      "guard: never drops every utterance, even when all look like filler",
      kept(decisions).length >= 1,
      `kept=[${kept(decisions).join(", ")}]`,
    );
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  console.log("CORRECTNESS CHECKS");
  for (const c of checks) {
    console.log(`  ${c.pass ? "✔" : "✖"} ${c.name}`);
    console.log(`      ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} correctness checks passed`);

  if (failed.length > 0) {
    console.error(`\n✖ ${failed.length} correctness check(s) failed — selection logic regressed.`);
    process.exit(1);
  }
};

main();

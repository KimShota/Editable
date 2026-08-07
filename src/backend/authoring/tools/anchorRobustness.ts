import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFormat } from "../../pipeline/loader";
import { splitTake, TakeSplit } from "../../pipeline/splitTake";
import { Format, Word } from "../../pipeline/types";

/**
 * Anchor robustness probe — the question this answers isn't "does the
 * pipeline recreate ONE specific reference reel" (verify.ts already
 * covers that), it's "does anchor matching hold up against a DIFFERENT
 * user saying the same lines with different wording, length, or pace",
 * which verify.ts structurally can't test since it only ever runs
 * against the one reel a template was reverse-engineered from.
 *
 * Anchors never touch pixels — matchLiteralAnchor (literal.ts) is pure
 * text matching over a Word[] transcript, and splitTake's own boundary
 * walk only needs a source file to ask ffmpeg where the silences are (see
 * detectSilenceIntervals). So this probes the REAL splitTake() walk —
 * same searchFloor advancement, same PAD_SEC/MIN_SPAN_SEC, no
 * reimplementation to drift out of sync — against hand-authored word
 * lists standing in for "arbitrary raw footage", paired with one throwaway
 * silent placeholder clip per scenario so detectSilenceIntervals has
 * something to ffprobe. No filming, no whisper, no render: each scenario
 * runs in well under a second.
 *
 *   npm run test:anchors [-- --format <id>]
 *
 * Two report sections, deliberately not conflated:
 *   - CORRECTNESS checks: scripted phrasings a working template MUST
 *     handle (paraphrase rejection, pacing/length invariance). These
 *     drive the exit code — a regression here is a real bug.
 *   - FRAGILITY probes: phrasings picked to stress a SPECIFIC risk in the
 *     anchor-matching algorithm (see each probe's own comment). These
 *     never fail the run — they're evidence-gathering, since "found
 *     nothing" and "found the bug" are both useful information about a
 *     template's real-world robustness, not a pass/fail gate on THIS
 *     template's authored anchors.
 */

const DEFAULT_FORMAT_ID = "abcd-heavier-to-carry-quiz";

// ---------------------------------------------------------------------------
// Synthetic transcript construction
// ---------------------------------------------------------------------------

const WORD_SEC = 0.32;
const GAP_SEC = 0.1;

/** Turns a plain sentence into a Word[] with synthetic timestamps — one
 *  "utterance" at a fixed pace. wordSec/gapSec are what the pacing
 *  scenarios below vary to simulate a slower or faster speaker. */
const wordsFromText = (text: string, opts: { startAt?: number; wordSec?: number; gapSec?: number } = {}): Word[] => {
  const wordSec = opts.wordSec ?? WORD_SEC;
  const gapSec = opts.gapSec ?? GAP_SEC;
  let t = opts.startAt ?? 0;
  const words: Word[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    words.push({ text: raw, startSec: t, endSec: t + wordSec });
    t += wordSec + gapSec;
  }
  return words;
};

let placeholderPath: string | undefined;
/** One reusable silent placeholder clip — splitTake's detectSilenceIntervals
 *  needs SOME file to ffprobe, but never reads its content beyond duration,
 *  so a single short silent clip serves every scenario (each passes its
 *  own word-derived duration straight to splitTake, independent of the
 *  placeholder's own length). */
const getPlaceholder = (): string => {
  if (placeholderPath && fs.existsSync(placeholderPath)) return placeholderPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-anchor-probe-"));
  placeholderPath = path.join(dir, "silent.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:d=1",
    "-f",
    "lavfi",
    "-i",
    "anullsrc",
    "-shortest",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    placeholderPath,
  ]);
  return placeholderPath;
};

const runWalk = (format: Format, words: Word[]): TakeSplit[] => {
  const coveredBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  const durationSec = words.length > 0 ? words[words.length - 1].endSec + 1 : 1;
  const result = splitTake(format, coveredBlocks, getPlaceholder(), durationSec, undefined, words);
  return result.blocks;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type CheckResult = { name: string; pass: boolean; detail: string };
const checks: CheckResult[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

type FragilityFinding = { name: string; risky: boolean; detail: string };
const findings: FragilityFinding[] = [];
const probe = (name: string, risky: boolean, detail: string) => findings.push({ name, risky, detail });

const blockById = (blocks: TakeSplit[], id: string) => blocks.find((b) => b.blockId === id);
const fmtSec = (n: number) => n.toFixed(2) + "s";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const main = () => {
  const args = process.argv.slice(2);
  const formatIdx = args.indexOf("--format");
  const formatId = formatIdx !== -1 ? args[formatIdx + 1] : DEFAULT_FORMAT_ID;
  const format = loadFormat(formatId);

  console.log(`anchor robustness probe — "${formatId}" (${format.blocks.length} blocks)\n`);

  // --- Correctness: baseline phrasing (mirrors the actual reference reel) ---
  {
    const words = wordsFromText(
      "What do you think is heavier to carry? A. A suitcase? B. A full laundry basket? " +
        "C. Knowing you had the potential and you had time but you kept treating both like " +
        "they would always be there you kept saying later like later was guaranteed and now " +
        "you are standing in the future you did not disappear D. A dozen grocery bags because " +
        "you had to eat right follow for more",
    );
    const blocks = runWalk(format, words);
    const ids = blocks.map((b) => b.blockId);
    check(
      "baseline: all 6 blocks resolve, in order",
      JSON.stringify(ids) === JSON.stringify(["hook", "option-a", "option-b", "option-c", "option-d", "cta"]),
      `got [${ids.join(", ")}]`,
    );
    const allConfident = blocks.every((b) => b.confidence > 0);
    check("baseline: every block matched with confidence > 0", allConfident, blocks.map((b) => `${b.blockId}=${b.confidence.toFixed(2)}`).join(" "));
    const optC = blockById(blocks, "option-c");
    check(
      "baseline: option-c spans the long monologue (not a sliver)",
      !!optC && optC.srcOutSec - optC.srcInSec > 8,
      optC ? `span=${fmtSec(optC.srcOutSec - optC.srcInSec)}` : "option-c missing",
    );
  }

  // --- Correctness: plain paraphrases are correctly NOT recognized ---
  // (anchors are meant to be strict — a template silently matching loose
  // paraphrases would be a worse bug than not matching at all, since a
  // wrong match mis-times overlays instead of visibly falling back)
  {
    // Deliberately avoids the indefinite article ("a suitcase") — that's
    // its own separate, already-covered fragility probe below. This
    // scenario isolates the plainer question: does a paraphrase that
    // never says the letter at all correctly fail to match?
    const words = wordsFromText(
      "What do you think is heavier to carry? First option, suitcase. " +
        "Second option, laundry basket. Then there is the emotional one about time. " +
        "Last option, groceries. Thanks for watching.",
    );
    const blocks = runWalk(format, words);
    const optA = blockById(blocks, "option-a");
    const optB = blockById(blocks, "option-b");
    check(
      "paraphrase (no letter said): option-a not falsely matched",
      !!optA && optA.confidence === 0,
      optA ? `confidence=${optA.confidence}, quote=${JSON.stringify(optA.quote ?? null)}` : "option-a missing",
    );
    check(
      "paraphrase (no letter said): option-b not falsely matched",
      !!optB && optB.confidence === 0,
      optB ? `confidence=${optB.confidence}` : "option-b missing",
    );
  }

  // --- Correctness: slower pacing shouldn't change WHAT matches ---
  {
    const words = wordsFromText(
      "What do you think is heavier to carry? A. A suitcase? B. A full laundry basket? C. " +
        "It is about knowing you had the time and you let it pass you by. D. A dozen grocery bags. Follow for more.",
      { wordSec: 0.6, gapSec: 0.45 },
    );
    const blocks = runWalk(format, words);
    const ids = blocks.map((b) => b.blockId);
    check(
      "slow pacing: same 6 blocks resolve, same order",
      JSON.stringify(ids) === JSON.stringify(["hook", "option-a", "option-b", "option-c", "option-d", "cta"]) &&
        blocks.every((b) => b.confidence > 0),
      `got [${ids.join(", ")}], confidences=[${blocks.map((b) => b.confidence.toFixed(2)).join(", ")}]`,
    );
  }

  // --- Correctness: a much longer answer per option should still resolve,
  // and the block's own span should grow to cover it (not truncate) ---
  {
    const words = wordsFromText(
      "What do you think is heavier to carry? A. Well obviously it would be the suitcase " +
        "because you have to lug it through the entire airport and that is exhausting on your " +
        "shoulder the whole way. B. A full laundry basket, especially when it is soaking wet " +
        "and the plastic handles dig into your fingers before you even reach the stairs. " +
        "C. Knowing you had the potential and you had time but you kept treating both like " +
        "they would always be there. D. A dozen grocery bags because you had to eat right and " +
        "your arms are shaking by the third flight of stairs. Follow for more.",
    );
    const blocks = runWalk(format, words);
    const optA = blockById(blocks, "option-a");
    const optB = blockById(blocks, "option-b");
    check(
      "long answers: option-a resolves and its span covers the full explanation",
      !!optA && optA.confidence > 0 && optA.srcOutSec - optA.srcInSec > 4,
      optA ? `confidence=${optA.confidence.toFixed(2)}, span=${fmtSec(optA.srcOutSec - optA.srcInSec)}` : "option-a missing",
    );
    check(
      "long answers: option-b resolves and its span covers the full explanation",
      !!optB && optB.confidence > 0 && optB.srcOutSec - optB.srcInSec > 4,
      optB ? `confidence=${optB.confidence.toFixed(2)}, span=${fmtSec(optB.srcOutSec - optB.srcInSec)}` : "option-b missing",
    );
  }

  // --- Fragility probe: does a stray indefinite article ("a") before the
  // real "A." marker get matched instead of it? "A."/"A" tokenize to the
  // single token "a" — identical to the English article, which is one of
  // the most common words in speech. splitTake's searchFloor only
  // advances PAST a block once its own marker is found, so any occurrence
  // of the bare word "a" INSIDE a block's own search window that happens
  // to precede the real marker is indistinguishable from it. ---
  {
    const words = wordsFromText(
      "What do you think is heavier, would you guess a suitcase? A. Yeah it is actually a suitcase. B. A full laundry basket? " +
        "C. Knowing you had the potential and you had time. D. A dozen grocery bags. Follow for more.",
    );
    const blocks = runWalk(format, words);
    const optA = blockById(blocks, "option-a");
    const realMarkerWord = words.find((w) => w.text === "A.");
    const matchedRealMarker = !!optA && !!realMarkerWord && Math.abs(optA.srcInSec - realMarkerWord.startSec) < 0.5;
    probe(
      "stray article 'a' ahead of the real 'A.' marker",
      !matchedRealMarker,
      matchedRealMarker
        ? "not triggered this time — real marker matched"
        : `TRIGGERED: option-a locked onto the earlier article "a" (start=${optA ? fmtSec(optA.srcInSec) : "?"}) ` +
          `instead of the real "A." marker (at ${realMarkerWord ? fmtSec(realMarkerWord.startSec) : "?"}) — ` +
          `a user who explains the question before announcing the letter will mis-split this block`,
    );
  }

  // --- Fragility probe: same shape, but for B/C/D — do any of THEIR
  // single-letter phrases collide with a common English word the way "A"
  // collides with the article "a"? (b/c/d aren't standalone English words,
  // so the expectation is these do NOT trigger — confirming the risk above
  // is specific to option-A's phrasing, not the anchor style in general) ---
  {
    // Seeds a valid hook + "A." first (unlike the flawed first draft of
    // this scenario, which opened straight into "B." with no hook match —
    // that left searchFloor stuck at 0 and let option-A's own stray-"a"
    // fragility contaminate the walk before B/C/D were ever reached,
    // producing a false positive that had nothing to do with B/C/D
    // themselves). With a clean floor established, this isolates exactly
    // one question per block: does a short common word near the marker
    // ("be", "could", "do") get mistaken for it?
    const words = wordsFromText(
      "What do you think is heavier to carry? A. Would you rather be a hero? B. A full laundry basket? " +
        "Could it be the emotional one? C. Knowing you had the potential and you had time. " +
        "Do you think it is heavy? D. A dozen grocery bags. Follow for more.",
    );
    const blocks = runWalk(format, words);
    for (const [id, phraseWord] of [
      ["option-b", "B."],
      ["option-c", "C."],
      ["option-d", "D."],
    ] as const) {
      const block = blockById(blocks, id);
      const realMarkerWord = words.find((w) => w.text === phraseWord);
      const matchedRealMarker = !!block && !!realMarkerWord && Math.abs(block.srcInSec - realMarkerWord.startSec) < 0.5;
      probe(
        `${id}: common nearby words ("be"/"could"/"do") don't collide with "${phraseWord}"`,
        !matchedRealMarker,
        matchedRealMarker ? "as expected — real marker matched, no collision" : `TRIGGERED: ${id} did not lock onto its real marker`,
      );
    }
  }

  // --- Correctness: user skips a marker outright (never says "D.") —
  // must degrade to a confidence-0 fallback, not throw or silently vanish ---
  {
    const words = wordsFromText(
      "What do you think is heavier to carry? A. A suitcase? B. A full laundry basket? " +
        "C. Knowing you had the potential and you had time. And then some groceries too. Follow for more.",
    );
    const blocks = runWalk(format, words);
    const optD = blockById(blocks, "option-d");
    check(
      "skipped marker ('D.' never said): option-d still emitted, confidence 0",
      !!optD && optD.confidence === 0,
      optD ? `confidence=${optD.confidence}, span=[${fmtSec(optD.srcInSec)}, ${fmtSec(optD.srcOutSec)}]` : "option-d missing entirely",
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

  console.log(`\nFRAGILITY PROBES (informational — never fail the run)`);
  for (const f of findings) {
    console.log(`  ${f.risky ? "⚠" : "·"} ${f.name}`);
    console.log(`      ${f.detail}`);
  }

  console.log(`\n${checks.length - failed.length}/${checks.length} correctness checks passed, ${findings.filter((f) => f.risky).length} fragility risk(s) confirmed`);

  if (failed.length > 0) {
    console.error(`\n✖ ${failed.length} correctness check(s) failed — a working template regressed.`);
    process.exit(1);
  }
};

main();

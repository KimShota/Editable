import { EdlSchema } from "../../pipeline/schemas";
import type { AdaptedScript, RecreationSpec } from "../../recreation/schemas";
import { makeChecker } from "../../tools/checks";
import { wordsFromAlignment } from "../../voice/elevenlabs";
import { planClip, requestSeconds } from "../clips";
import { captionGroups, compileEdl, type MadeClip, swapShotClip } from "../edl";
import { seedanceUsd } from "../higgsfield";
import { clipProblem, pickBest, RETRY_CAP, usable, worstCaseUsd } from "../retry";
import { buildTimeline, MIN_SHOT_SEC } from "../timeline";

/**
 * Production planning with no network, no provider and no ffmpeg: the
 * timeline mapping, clip routing, captions, pricing and the EDL.
 *
 *   npm run test:production
 */

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// Source: two lines (0-4s, 4-10s), three shots cut at 2s (mid line 0) and 7s (mid line 1).
const spec = {
  media: { durationSec: 10.5, width: 720, height: 1280, fps: 30 },
  speech: {
    lines: [
      { text: "a b", startSec: 0, endSec: 4, role: "hook", shotIds: ["s0", "s1"], wordCount: 2 },
      { text: "c d", startSec: 4, endSec: 10, role: "cta", shotIds: ["s1", "s2"], wordCount: 2 },
    ],
    wordsPerMin: 100,
  },
  shots: [
    { id: "s0", startSec: 0, endSec: 2 },
    { id: "s1", startSec: 2, endSec: 7 },
    { id: "s2", startSec: 7, endSec: 10.5 },
  ],
} as unknown as RecreationSpec;

const shot = (shotId: string, treatment: AdaptedScript["shots"][number]["treatment"], footageId: string | null = null, textOnScreen: AdaptedScript["shots"][number]["textOnScreen"] = []) => ({
  shotId,
  treatment,
  action: "a",
  footageId,
  otherScreen: null,
  textOnScreen,
  sourceStartSec: 0,
  sourceEndSec: 1,
  sourceKind: "talking" as const,
});
const script = {
  sourceId: "src",
  shots: [shot("s0", "character_talking", null, [{ text: "HOOK", role: "hook_title", position: "top" }]), shot("s1", "screen_fill", "draft"), shot("s2", "device_closeup", "draft")],
} as unknown as AdaptedScript;

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
// The new lines run 2s and 3s (both shorter than the source's 4s and 6s).
const voiced = [
  { index: 0, durationSec: 2, words: [w("If", 0, 0.3), w("I", 0.3, 0.5), w("lost", 0.5, 1), w("everything,", 1, 1.8)] },
  { index: 1, durationSec: 3, words: [w("Press", 0, 0.5), w("Option.", 0.5, 1.2), w("Done.", 1.6, 2.8)] },
];

const main = () => {
  const t = makeChecker();

  const tl = buildTimeline(script, spec, voiced);
  t.check("lines follow each other with a short pause", tl.lines[0].tlInSec === 0 && near(tl.lines[1].tlInSec, 2.08, 1e-9), JSON.stringify(tl.lines.map((l) => l.tlInSec)));
  t.check("a cut halfway through a source line lands halfway through the new line", near(tl.shots[1].tlInSec, 1, 1e-9), String(tl.shots[1].tlInSec));
  t.check("a cut mid-line maps proportionally (7s = half of line 1)", near(tl.shots[2].tlInSec, 2.08 + 1.5, 1e-9), String(tl.shots[2].tlInSec));
  t.check("the video ends after the last line plus a short tail", near(tl.durationSec, 5.08 + 0.5, 1e-9) && tl.shots[2].tlOutSec === tl.durationSec, String(tl.durationSec));
  t.check("word times move with their line", near(tl.lines[1].words[2].tlStartSec, 2.08 + 1.6, 1e-9));

  // A source cut that would leave a sliver gets pushed to the minimum length.
  const tight = buildTimeline(script, { ...spec, shots: [spec.shots[0], { ...spec.shots[1], startSec: 0.1 }, spec.shots[2]] } as RecreationSpec, voiced);
  t.check("no shot is shorter than the minimum", tight.shots.every((s) => s.tlOutSec - s.tlInSec >= MIN_SHOT_SEC - 1e-9), JSON.stringify(tight.shots));
  t.throws("a missing voiced line is an error", () => buildTimeline(script, spec, voiced.slice(1)), /voiced lines/);

  t.check("talking shots are lip-synced", planClip(script.shots[0]) === "talking");
  t.check("product footage filling the frame is not generated", planClip(script.shots[1]) === "footage");
  t.check("a device showing the product goes through the green screen", planClip(script.shots[2]) === "green");
  t.check("a device with a non-product screen is just animated", planClip({ ...script.shots[2], footageId: null }) === "animate");
  t.check("requests respect each model's minimum length", requestSeconds("talking", 1.2) === 4 && requestSeconds("animate", 1.2) === 3 && requestSeconds("animate", 4.9) === 6);
  t.check("seedance price follows its token formula (720p 9:16, 8s)", near(seedanceUsd({ resolution: "720p", aspect_ratio: "9:16", duration: 8 }), 3.6979, 1e-3));

  // Retry caps and checks (retry.ts), on DbAJ's real numbers.
  t.check("retries go to the shots worth paying for", RETRY_CAP.talking === 1 && RETRY_CAP.green === 2 && RETRY_CAP.animate === 0 && RETRY_CAP.footage === 0);
  t.check("a green screen clean almost to the end passes (s6 played at 0.97x)", clipProblem("green", 4.3, { cleanUntilSec: 4.17 }) === null);
  t.check("a green screen drawn on early is retried (s11: 0.2s of 1.2s)", clipProblem("green", 1.2, { cleanUntilSec: 0.2 }) !== null);
  t.check("tight lips pass, drifting lips are retried", clipProblem("talking", 6.4, { lipSyncDriftSec: 0.05 }) === null && clipProblem("talking", 6.4, { lipSyncDriftSec: 0.3 }) !== null);
  t.check("a clip whose line can't be found is retried", /could not be found/.test(clipProblem("talking", 6.4, { lipSyncDriftSec: Infinity }) ?? ""));
  t.check("animate shots have no automatic check", clipProblem("animate", 3, {}) === null);
  t.check("a green screen clean for a sliver is not usable (s15: 0.25s of 5.9s)", !usable("green", 5.9, { cleanUntilSec: 0.25 }) && usable("green", 5.9, { cleanUntilSec: 3 }));
  t.check("a badly synced talking clip is still usable", usable("talking", 6.4, { lipSyncDriftSec: Infinity }));
  const a = (problem: string | null, q: { cleanUntilSec?: number; lipSyncDriftSec?: number }, id: string) => ({ ...q, problem, id });
  t.check("a passing attempt is kept over a failing one", pickBest("green", [a("x", { cleanUntilSec: 2 }, "1"), a(null, { cleanUntilSec: 9 }, "2")])?.id === "2");
  t.check("with no passing attempt, the longest clean part wins", pickBest("green", [a("x", { cleanUntilSec: 1 }, "1"), a("x", { cleanUntilSec: 2 }, "2"), a("x", { cleanUntilSec: 0.5 }, "3")])?.id === "2");
  t.check("with no passing attempt, the tightest lips win", pickBest("talking", [a("x", { lipSyncDriftSec: 0.4 }, "1"), a("x", { lipSyncDriftSec: 0.2 }, "2")])?.id === "2");
  t.check("no attempts, nothing to keep", pickBest("talking", []) === undefined);
  t.check(
    "worst case = every retry used",
    near(worstCaseUsd("talking", 3.24), 6.48, 1e-9) && near(worstCaseUsd("green", 0.215, 0.134), 0.215 * 3 + 0.134 * 3, 1e-9) && worstCaseUsd("animate", 0.21) === 0.21,
  );

  t.check(
    "ElevenLabs characters group into words",
    JSON.stringify(wordsFromAlignment({ characters: [..."Hi, you"], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] })) ===
      JSON.stringify([{ text: "Hi,", startSec: 0, endSec: 0.3 }, { text: "you", startSec: 0.4, endSec: 0.7 }]),
  );

  const caps = captionGroups(tl.lines);
  t.check("captions break at punctuation and at three words", caps.map((g) => g.words.map((x) => x.text).join(" ")).join(" | ") === "If I lost | everything, | Press Option. | Done.", caps.map((g) => g.words.map((x) => x.text).join(" ")).join(" | "));
  t.check("a caption holds through a short pause", caps[2].tlOutSec === caps[3].tlInSec);

  const clip = (s: string, durationSec: number, inSec = 0): MadeClip => ({ src: `jobs/j/${s}.mp4`, file: `/abs/${s}.mp4`, durationSec, inSec });
  const edl = EdlSchema.parse(
    compileEdl({
      jobId: "j",
      script,
      spec,
      timeline: tl,
      clips: new Map([["s0", clip("s0", 4, 0.2)], ["s1", clip("s1", 0.9)], ["s2", clip("s2", 5)]]),
      voice: new Map([[0, { src: "jobs/j/l0.mp3", file: "/abs/l0.mp3", durationSec: 2 }], [1, { src: "jobs/j/l1.mp3", file: "/abs/l1.mp3", durationSec: 3 }]]),
    }),
  );
  t.check("every shot is its own muted clip on the main track", edl.video.length === 3 && edl.video.every((v) => v.muted));
  t.check("a lip-synced clip plays from its speech offset", edl.video[0].srcInSec === 0.2 && near(edl.video[0].srcOutSec, 0.2 + 1, 1e-9));
  t.check("a clip shorter than its shot slows down instead of freezing", edl.video[1].speed < 1, String(edl.video[1].speed));
  t.check("a short clip is never read past its usable end", near(edl.video[1].srcOutSec, 0.9, 1e-9), String(edl.video[1].srcOutSec));
  t.check("a very slow clip is flagged", edl.diagnostics.some((d) => d.startsWith("s1:")), edl.diagnostics.join("; "));
  t.check("every line is its own voice clip", edl.voiceovers.map((v) => `${v.id}@${v.tlInSec}`).join() === "line-0@0,line-1@2.08");
  t.check("on-screen text is an editable overlay, not burned in", edl.overlays.length === 1 && edl.overlays[0].component === "TextOverlay" && edl.overlays[0].params.text === "HOOK");
  t.check("captions are editable groups", edl.captions.length === 4 && edl.captionStyle?.params.position === "center");
  t.check("every file is staged", Object.keys(edl.assets).length === 5 && edl.assets["jobs/j/s0.mp4"] === "/abs/s0.mp4");
  // Regenerating one shot inside an edited timeline.
  const edited = { ...edl, overlays: [{ ...edl.overlays[0], params: { text: "EDITED" } }], video: [edl.video[0], { ...edl.video[1], id: "s1a", tlOutSec: 2 }, { ...edl.video[1], id: "s1b", tlInSec: 2 }, edl.video[2]] };
  const swapped = swapShotClip(edited, "s1", clip("s1.v2", 5, 0.5));
  t.check("a regenerated shot replaces every piece of that shot", swapped.video.filter((v) => v.src === "jobs/j/s1.v2.mp4").map((v) => v.id).join() === "s1a,s1b");
  t.check("pieces keep their place on the timeline and continue through the new take", swapped.video[1].tlInSec === edited.video[1].tlInSec && near(swapped.video[1].srcInSec, 0.5, 1e-9) && near(swapped.video[2].srcInSec, 0.5 + (2 - edited.video[1].tlInSec), 1e-9));
  t.check("other shots and every edit stay as they were", swapped.video[0] === edited.video[0] && swapped.overlays[0].params.text === "EDITED" && swapped.assets["jobs/j/s1.v2.mp4"] === "/abs/s1.v2.mp4" && swapped.assets["jobs/j/s1.mp4"] !== undefined);
  t.throws("a shot that is not on the timeline is an error", () => swapShotClip(edl, "s9", clip("s9", 3)), /no clip of shot s9/);

  t.throws("a missing clip is an error", () => compileEdl({ jobId: "j", script, spec, timeline: tl, clips: new Map(), voice: new Map() }), /no clip/);

  t.finish("production");
};

main();

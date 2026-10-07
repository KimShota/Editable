import { costReport, parseCostLog } from "../../cost/report";
import { EdlSchema } from "../../pipeline/schemas";
import { applyOp } from "../../pipeline/timelineOps";
import type { Edl } from "../../pipeline/types";
import type { AdaptedScript, RecreationSpec } from "../../recreation/schemas";
import { makeChecker } from "../../tools/checks";
import { wordsFromAlignment } from "../../voice/elevenlabs";
import { DEFAULT_AUDIO_MODE, parseAudioMode } from "../audioMode";
import { animatePrompt, nativeTalkingPrompt, planClip, requestSeconds, spokenShare } from "../clips";
import { captionGroups, compileEdl, type MadeClip, playRawClipAudio, swapShotClip } from "../edl";
import { seedanceUsd } from "../higgsfield";
import { clipProblem, pickBest, RETRY_CAP, usable, worstCaseUsd } from "../retry";
import { alignWords, buildNativeTimeline, buildTimeline, MIN_SHOT_SEC, onCameraLines, speakingShots } from "../timeline";

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

  t.check("talking shots with words are lip-synced", planClip(script.shots[0], true) === "talking");
  t.check("a talking shot with no words is a silent animated clip, never a paid talking clip", planClip(script.shots[0], false) === "animate");
  t.check("the silent clip is told she does not speak", /does not speak/.test(animatePrompt(script.shots[0], "animate")) && !/does not speak/.test(animatePrompt({ ...script.shots[2], footageId: null }, "animate")));
  t.check("product footage filling the frame is not generated", planClip(script.shots[1], true) === "footage");
  t.check("a device showing the product plays the footage itself, never the green screen", planClip(script.shots[2], true) === "footage");
  t.check("a device with a non-product screen is just animated", planClip({ ...script.shots[2], footageId: null }, true) === "animate");
  const withDelivery = (d: string[]) => ({ ...spec, speech: { ...spec.speech, lines: spec.speech.lines.map((l, i) => ({ ...l, delivery: d[i] })) } }) as unknown as RecreationSpec;
  t.check("only lines a visible person says count as on camera", [...onCameraLines(withDelivery(["on_camera", "voiceover"]))].join() === "0");
  t.check("a spec without delivery counts every line", [...onCameraLines(spec)].join() === "0,1");
  t.check("a shot under a voiceover gets no talking clip", [...speakingShots(tl, onCameraLines(withDelivery(["voiceover", "voiceover"])))].length === 0);
  t.check("only the shots a visible person speaks in are talking shots", [...speakingShots(tl, onCameraLines(withDelivery(["on_camera", "voiceover"])))].join() === "s0,s1", JSON.stringify(tl.shots));
  t.check("every shot a voiced line overlaps speaks", [...speakingShots(tl)].join() === "s0,s1,s2");
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
  const a = (problem: string | null, q: { cleanUntilSec?: number; lipSyncDriftSec?: number; spokenShare?: number }, id: string) => ({ ...q, problem, id });
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
  t.check("each voice line records where it was generated, for 'back to the original position'", edl.voiceovers.every((v) => v.original?.tlInSec === v.tlInSec && v.original?.tlOutSec === v.tlOutSec && v.original?.srcOutSec === v.srcOutSec));
  t.check("on-screen text is an editable overlay, not burned in", edl.overlays.length === 1 && edl.overlays[0].component === "TextOverlay" && edl.overlays[0].params.text === "HOOK");
  t.check("captions are editable groups", edl.captions.length === 4 && edl.captionStyle?.params.position === "center");
  const labelled = compileEdl({
    jobId: "j",
    script: {
      ...script,
      shots: script.shots.map((s) =>
        s.shotId === "s1"
          ? { ...s, treatment: "screen_fill" as const, textOnScreen: [{ text: "Step", role: "label" as const, position: "bottom" as const }, { text: "Comment X", role: "cta" as const, position: "bottom" as const }] }
          : s,
      ),
    },
    spec,
    timeline: tl,
    clips: new Map([["s0", clip("s0", 4, 0.2)], ["s1", clip("s1", 0.9)], ["s2", clip("s2", 5)]]),
    voice: new Map([[0, { src: "jobs/j/l0.mp3", file: "/abs/l0.mp3", durationSec: 2 }], [1, { src: "jobs/j/l1.mp3", file: "/abs/l1.mp3", durationSec: 3 }]]),
  });
  const [step, cta] = ["text-s1-0", "text-s1-1"].map((id) => labelled.overlays.find((o) => o.id === id)!);
  t.check("two bottom texts in one shot stack, the last lowest", cta.y === 0.7 && near(step.y + step.height, cta.y, 1e-9), `${step.y} ${cta.y}`);
  t.check("labels on a screen recording get a dark pill; a hook over a person does not", typeof step.params.background === "string" && typeof cta.params.background === "string" && labelled.overlays.find((o) => o.id === "text-s0-0")?.params.background === undefined);
  t.check("every file is staged", Object.keys(edl.assets).length === 5 && edl.assets["jobs/j/s0.mp4"] === "/abs/s0.mp4");
  // Regenerating one shot inside an edited timeline.
  const edited = { ...edl, overlays: [{ ...edl.overlays[0], params: { text: "EDITED" } }], video: [edl.video[0], { ...edl.video[1], id: "s1a", tlOutSec: 2 }, { ...edl.video[1], id: "s1b", tlInSec: 2 }, edl.video[2]] };
  const swapped = swapShotClip(edited, "s1", clip("s1.v2", 5, 0.5));
  t.check("a regenerated shot replaces every piece of that shot", swapped.video.filter((v) => v.src === "jobs/j/s1.v2.mp4").map((v) => v.id).join() === "s1a,s1b");
  t.check("pieces keep their place on the timeline and continue through the new take", swapped.video[1].tlInSec === edited.video[1].tlInSec && near(swapped.video[1].srcInSec, 0.5, 1e-9) && near(swapped.video[2].srcInSec, 0.5 + (2 - edited.video[1].tlInSec), 1e-9));
  t.check("other shots and every edit stay as they were", swapped.video[0] === edited.video[0] && swapped.overlays[0].params.text === "EDITED" && swapped.assets["jobs/j/s1.v2.mp4"] === "/abs/s1.v2.mp4" && swapped.assets["jobs/j/s1.mp4"] !== undefined);
  t.throws("a shot that is not on the timeline is an error", () => swapShotClip(edl, "s9", clip("s9", 3)), /no clip of shot s9/);

  // Native audio: the clips speak for themselves.
  t.check("native audio is the default", DEFAULT_AUDIO_MODE === "native" && parseAudioMode({}) === "native" && parseAudioMode(null) === "native");
  t.check("a brand can stay on re-voice", parseAudioMode({ audioMode: "revoice" }) === "revoice");
  t.throws("an unknown audio mode is an error", () => parseAudioMode({ audioMode: "dub" }), /audioMode/);
  const nativeScript = { ...script, lines: [{ index: 0, text: "If I lost everything," }, { index: 1, text: "Press Option. Done." }] } as unknown as AdaptedScript;
  const ntl = buildNativeTimeline(nativeScript, spec);
  // Line 0 (0-4s) sits in s0 (0-2s, 2s) and s1 (2-7s): s1 holds more of it, so s1 says it; line 1 (4-10s) is mostly s1/s2 too.
  t.check("each line is said in exactly one shot", ntl.lines.length === 2 && ntl.lines.every((l) => ntl.shots.filter((s) => l.tlInSec >= s.tlInSec && l.tlOutSec <= s.tlOutSec + 1e-9).length === 1), JSON.stringify(ntl));
  t.check("shots keep their order and run back to back", ntl.shots.map((x) => x.shotId).join() === "s0,s1,s2" && ntl.shots.every((x, i) => i === 0 || near(x.tlInSec, ntl.shots[i - 1].tlOutSec, 1e-9)) && near(ntl.shots[2].tlOutSec, ntl.durationSec, 1e-9));
  t.check("a shot with speech is as long as its words need, not as long as the source's shot", near(ntl.shots[0].tlOutSec - ntl.shots[0].tlInSec, 0.2 + (4 * 60) / 160 + 0.3, 1e-9) && near(ntl.shots[1].tlOutSec - ntl.shots[1].tlInSec, 0.2 + (3 * 60) / 160 + 0.3, 1e-9), JSON.stringify(ntl.shots));
  t.check("a shot with no speech keeps the source's length", near(ntl.shots[2].tlOutSec - ntl.shots[2].tlInSec, 3.5, 1e-9), JSON.stringify(ntl.shots));
  t.check("in native audio only the shots that say a line speak", [...speakingShots(ntl)].join() === "s0,s1", JSON.stringify([...speakingShots(ntl)]));
  const speechSec = (l: { tlInSec: number; tlOutSec: number }, words: number) => near(l.tlOutSec - l.tlInSec, (words * 60) / 160, 1e-9);
  t.check("lines run at a normal pace, not the source's", speechSec(ntl.lines[0], 4) && speechSec(ntl.lines[1], 3));
  t.check("estimated words fill their line", ntl.lines[0].words.length === 4 && ntl.lines[0].words[0].tlStartSec === ntl.lines[0].tlInSec && near(ntl.lines[0].words[3].tlEndSec, ntl.lines[0].tlOutSec, 1e-9));
  // A fast source: 30 words in a 4s shot need about 11.3s at 160 wpm.
  const fastSpec = { ...spec, media: { ...spec.media, durationSec: 5 }, speech: { ...spec.speech, lines: [{ ...spec.speech.lines[0], startSec: 0, endSec: 4 }, { ...spec.speech.lines[1], startSec: 4, endSec: 4.5 }] }, shots: [{ id: "s0", startSec: 0, endSec: 4 }, { id: "s1", startSec: 4, endSec: 4.5 }, { id: "s2", startSec: 4.5, endSec: 5 }] } as unknown as RecreationSpec;
  const words30 = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const fast = buildNativeTimeline({ ...nativeScript, lines: [{ index: 0, text: words30 }, { index: 1, text: "Done." }] } as unknown as AdaptedScript, fastSpec);
  t.check("a shot grows to fit its words, and the shots after it move later", fast.shots[0].tlOutSec - fast.shots[0].tlInSec > 10 && fast.shots[1].tlInSec === fast.shots[0].tlOutSec && fast.durationSec > 5, JSON.stringify(fast.shots));
  t.check("a shot is never asked to run past the model's limit", fast.shots.every((x) => x.tlOutSec - x.tlInSec <= 12 + 1e-9));
  t.throws("a script with another line count is an error", () => buildNativeTimeline({ ...nativeScript, lines: [nativeScript.lines[0]] } as AdaptedScript, spec), /script lines/);
  t.check("a clip that speaks at a normal pace passes and a rushed one is retried", clipProblem("talking", 6, { wordsPerMin: 170 }) === null && /too fast/.test(clipProblem("talking", 6, { wordsPerMin: 400 }) ?? ""));
  const heard3 = [{ startSec: 0.4, endSec: 0.8 }, { startSec: 0.9, endSec: 1.3 }, { startSec: 1.4, endSec: 2 }];
  const exact = alignWords("Press Option. Done.", heard3)!;
  t.check("script words take the heard times when the counts match", exact.map((x) => x.text).join(" ") === "Press Option. Done." && exact[1].tlStartSec === 0.9);
  const spread = alignWords("Press Option and be done.", heard3)!;
  t.check("otherwise the words spread across the heard speech", spread.length === 5 && spread[0].tlStartSec === 0.4 && near(spread[4].tlEndSec, 2, 1e-9));
  t.check("nothing heard, nothing to align", alignWords("Press Option.", []) === null);
  const said = (...w: string[]) => w.map((word) => ({ word }));
  t.check("a clip that says the whole line passes", spokenShare("Press Option. Done.", said("press", "option", "done")) === 1 && clipProblem("talking", 4, { spokenShare: 1 }) === null);
  t.check("words out of order do not count", spokenShare("Press Option. Done.", said("done", "option", "press")) < 1);
  t.check("a clip that says too little is retried", /only/.test(clipProblem("talking", 4, { spokenShare: 0.3 }) ?? ""));
  t.check("a clip with no speech is retried", /no speech/.test(clipProblem("talking", 4, { spokenShare: 0 }) ?? ""));
  t.check("with no passing attempt, the clip that says most of the line wins", pickBest("talking", [a("x", { spokenShare: 0.2 }, "1"), a("x", { spokenShare: 0.5 }, "2")])?.id === "2");
  const prompt = nativeTalkingPrompt(script.shots[0], "Nova", "Press Option.", "Female, cool and composed.");
  const quiet = nativeTalkingPrompt(script.shots[0], "Nova", "", "x");
  t.check("a shot with no line does not speak", /does not speak/.test(quiet) && !/says exactly/.test(quiet));
  t.check("the native prompt asks for a natural pace", /natural relaxed conversational pace/.test(prompt));
  t.check("the native prompt carries the words and the voice, and supplies no audio reference", prompt.includes('"Press Option."') && prompt.includes("Female, cool and composed.") && !/audio 1/.test(prompt));
  const nativeEdl = EdlSchema.parse(
    compileEdl({ jobId: "j", script, spec, timeline: ntl, clips: new Map([["s0", clip("s0", 4)], ["s1", clip("s1", 6)], ["s2", clip("s2", 5)]]), voice: new Map(), speaking: new Set(["s0"]) }),
  );
  t.check("a speaking shot plays its own audio and the rest stay muted", nativeEdl.video.map((v) => v.muted).join() === "false,true,true");
  t.check("native audio has no voice track", nativeEdl.voiceovers.length === 0);


  t.throws("a missing clip is an error", () => compileEdl({ jobId: "j", script, spec, timeline: tl, clips: new Map(), voice: new Map() }), /no clip/);

  // The generated voice lines are editable, and each can go back to where it was generated (the lip-synced position).
  {
    const at = (tlInSec: number, tlOutSec: number) => ({ tlInSec, tlOutSec, srcInSec: 0, srcOutSec: tlOutSec - tlInSec });
    const doc = EdlSchema.parse({
      jobId: "j",
      formatId: "ai-video",
      fps: 30,
      width: 360,
      height: 640,
      durationSec: 10,
      video: [{ id: "v", blockId: "s0", src: "v.mp4", srcInSec: 0, srcOutSec: 10, srcDurationSec: 10, tlInSec: 0, tlOutSec: 10, muted: true, speed: 1, volume: 1, zoom: 1 }],
      voiceovers: [
        { id: "line-0", blockId: "line-0", src: "a.mp3", ...at(1, 3), volume: 1, original: at(1, 3) },
        { id: "line-1", blockId: "line-1", src: "b.mp3", ...at(4, 6), volume: 1 }, // from before `original` existed
      ],
    });
    const line = (e: ReturnType<typeof applyOp>, id: string) => e.voiceovers.find((v) => v.id === id)!;

    const moved = applyOp(doc, { type: "voiceMove", id: "line-0", tlInSec: 5 });
    t.check("a voice line moves and keeps its length", line(moved, "line-0").tlInSec === 5 && line(moved, "line-0").tlOutSec === 7);
    t.check("moving a line leaves the source take alone, so playback is the same audio", line(moved, "line-0").srcInSec === 0 && line(moved, "line-0").srcOutSec === 2);
    t.check("the input document is never changed", line(doc, "line-0").tlInSec === 1);
    t.check("a line cannot be moved off the end of the video or before zero", line(applyOp(doc, { type: "voiceMove", id: "line-0", tlInSec: 9.5 }), "line-0").tlOutSec === 10 && line(applyOp(doc, { type: "voiceMove", id: "line-0", tlInSec: 0 }), "line-0").tlInSec === 0);

    const back = applyOp(moved, { type: "voiceReset", ids: ["line-0"] });
    t.check("back to the original position restores the generated place and take", JSON.stringify([line(back, "line-0").tlInSec, line(back, "line-0").tlOutSec, line(back, "line-0").srcInSec, line(back, "line-0").srcOutSec]) === "[1,3,0,2]");

    const lazy = applyOp(doc, { type: "voiceMove", id: "line-1", tlInSec: 7 });
    t.check("a line with no recorded original gets one on its first edit", JSON.stringify(line(lazy, "line-1").original) === JSON.stringify(at(4, 6)));
    t.check("…so it can go back too", line(applyOp(lazy, { type: "voiceReset", ids: ["line-1"] }), "line-1").tlInSec === 4);
    t.check("resetting a line that was never edited changes nothing", JSON.stringify(applyOp(doc, { type: "voiceReset", ids: ["line-1"] }).voiceovers) === JSON.stringify(doc.voiceovers));
    t.check("several lines reset at once", line(applyOp(applyOp(moved, { type: "voiceMove", id: "line-1", tlInSec: 8 }), { type: "voiceReset", ids: ["line-0", "line-1"] }), "line-1").tlInSec === 4);

    const cutOut = applyOp(doc, { type: "voiceTrim", id: "line-0", edge: "out", tlSec: 2.5 });
    t.check("trimming the end shortens the line and the take together", line(cutOut, "line-0").tlOutSec === 2.5 && line(cutOut, "line-0").srcOutSec === 1.5);
    const cutIn = applyOp(doc, { type: "voiceTrim", id: "line-0", edge: "in", tlSec: 1.5 });
    t.check("trimming the start moves the take's start by the same amount", line(cutIn, "line-0").tlInSec === 1.5 && line(cutIn, "line-0").srcInSec === 0.5);
    t.check("a trimmed line can be pulled back out to its take, no further", line(applyOp(cutOut, { type: "voiceTrim", id: "line-0", edge: "out", tlSec: 9 }), "line-0").tlOutSec === 3 && line(applyOp(cutIn, { type: "voiceTrim", id: "line-0", edge: "in", tlSec: 0 }), "line-0").tlInSec === 1);
    t.check("a line cannot be trimmed to nothing", line(applyOp(doc, { type: "voiceTrim", id: "line-0", edge: "out", tlSec: 1 }), "line-0").tlOutSec > 1.05 && line(applyOp(doc, { type: "voiceTrim", id: "line-0", edge: "in", tlSec: 3 }), "line-0").tlInSec < 2.95);
    t.check("back to the original position undoes a trim as well as a move", JSON.stringify(line(applyOp(applyOp(cutIn, { type: "voiceMove", id: "line-0", tlInSec: 6 }), { type: "voiceReset", ids: ["line-0"] }), "line-0")) === JSON.stringify(line(doc, "line-0")));

    t.check("volume is set on the line", line(applyOp(doc, { type: "voiceVolume", id: "line-0", volume: 0.4 }), "line-0").volume === 0.4);
    const gone = applyOp(doc, { type: "voiceDelete", ids: ["line-0"] });
    t.check("a voice line can be deleted, leaving the others", gone.voiceovers.length === 1 && gone.voiceovers[0].id === "line-1");
    t.check("several voice lines delete at once", applyOp(doc, { type: "voiceDelete", ids: ["line-0", "line-1"] }).voiceovers.length === 0);
    t.check("deleting a line leaves the input document alone", doc.voiceovers.length === 2);
    t.throws("deleting an unknown line is refused", () => applyOp(doc, { type: "voiceDelete", ids: ["line-0", "line-9"] }), /not found/);
    t.throws("an unknown line is an error", () => applyOp(doc, { type: "voiceMove", id: "line-9", tlInSec: 1 }), /not found/);
    t.throws("a volume outside the range is refused", () => applyOp(doc, { type: "voiceVolume", id: "line-0", volume: 11 }));
  }

  {
    const at = (a: number, b: number) => ({ tlInSec: a, tlOutSec: b, srcInSec: 0, srcOutSec: b - a });
    const seg = (id: string, a: number, b: number) => ({ id, blockId: id, src: `${id}.mp4`, srcInSec: 0, srcOutSec: b - a, srcDurationSec: 5, tlInSec: a, tlOutSec: b, muted: true, speed: 1.4, volume: 1, zoom: 1 });
    const doc = EdlSchema.parse({
      jobId: "j", formatId: "ai-video", fps: 30, width: 360, height: 640, durationSec: 10,
      video: [seg("s0", 0, 2), seg("s1", 2, 5)],
      voiceovers: [
        { id: "line-0", blockId: "line-0", src: "a.mp3", ...at(0, 1.5), volume: 1 },
        { id: "line-1", blockId: "line-1", src: "b.mp3", ...at(1.6, 4), volume: 1 },
        { id: "line-2", blockId: "line-2", src: "c.mp3", ...at(6, 8), volume: 1 },
      ],
      assets: {},
    });
    const raw = { src: "s0.raw.mp4", file: "/x/s0.raw.mp4", durationSec: 4, inSec: 0.3 };
    const out = playRawClipAudio(doc, "s0", raw);
    const s0 = out.video.find((v) => v.id === "s0")!;
    t.check("the shot plays its raw clip, unmuted, at natural speed, in the same slot", s0.src === "s0.raw.mp4" && !s0.muted && s0.speed === 1 && s0.tlInSec === 0 && s0.tlOutSec === 2);
    t.check("it starts where the speech starts and ends within the raw clip", s0.srcInSec === 0.3 && s0.srcOutSec === 2.3 && out.assets["s0.raw.mp4"] === "/x/s0.raw.mp4");
    t.check("other shots are untouched", JSON.stringify(out.video[1]) === JSON.stringify(doc.video[1]));
    t.check("a line inside the slot is removed", !out.voiceovers.some((v) => v.id === "line-0"));
    const l1 = out.voiceovers.find((v) => v.id === "line-1")!;
    t.check("a line running past the slot is trimmed back to it, its take moving with it", l1.tlInSec === 2 && l1.tlOutSec === 4 && Math.abs(l1.srcInSec - 0.4) < 1e-9 && l1.srcOutSec === 2.4);
    t.check("a kept piece is its own generated line, so it cannot be put back under the clip", JSON.stringify(l1.original) === JSON.stringify({ tlInSec: l1.tlInSec, tlOutSec: l1.tlOutSec, srcInSec: l1.srcInSec, srcOutSec: l1.srcOutSec }));
    t.check("a line elsewhere is untouched", JSON.stringify(out.voiceovers.find((v) => v.id === "line-2")) === JSON.stringify(doc.voiceovers[2]));
    const wide = playRawClipAudio(EdlSchema.parse({ ...doc, voiceovers: [{ id: "long", blockId: "long", src: "l.mp3", ...at(1, 6), volume: 1 }] }), "s1", { ...raw, src: "s1.raw.mp4" });
    t.check("a line spanning the whole slot keeps both sides", JSON.stringify(wide.voiceovers.map((v) => [v.id, v.tlInSec, v.tlOutSec])) === JSON.stringify([["long", 1, 2], ["long-b", 5, 6]]));
    t.check("the input document is never changed", doc.video[0].muted === true && doc.voiceovers.length === 3);
    t.throws("a shot that is not on the timeline is an error", () => playRawClipAudio(doc, "s9", raw), /no clip of shot/);
  }

  {
    // The magnetic main track: every other layer moves with the clip it starts on.
    const seg = (id: string, a: number, b: number, speed = 1) => ({ id, blockId: id, src: `${id}.mp4`, srcInSec: 0, srcOutSec: (b - a) * speed, srcDurationSec: 10, tlInSec: a, tlOutSec: b, muted: true, speed, volume: 1, zoom: 1 });
    const words = (a: number, b: number) => [{ text: "hi", tlStartSec: a, tlEndSec: b, emphasis: false }];
    const doc = EdlSchema.parse({
      jobId: "j", formatId: "ai-video", fps: 30, width: 360, height: 640, durationSec: 9,
      video: [seg("a", 0, 3), seg("b", 3, 5, 1.5), seg("c", 5, 9)],
      voiceovers: [
        { id: "va", blockId: "va", src: "a.mp3", tlInSec: 0.5, tlOutSec: 2.5, srcInSec: 0, srcOutSec: 2, volume: 1 },
        { id: "vc", blockId: "vc", src: "c.mp3", tlInSec: 5.5, tlOutSec: 7, srcInSec: 0, srcOutSec: 1.5, volume: 1, original: { tlInSec: 5.5, tlOutSec: 7, srcInSec: 0, srcOutSec: 1.5 } },
      ],
      captions: [
        { id: "ca", words: words(0.5, 1), tlInSec: 0.5, tlOutSec: 1 },
        { id: "cb", words: words(3, 4), tlInSec: 3, tlOutSec: 4 },
        { id: "cc", words: words(6, 6.5), tlInSec: 6, tlOutSec: 6.5 },
      ],
      overlays: [
        { id: "title", component: "TextOverlay", params: {}, tlInSec: 4, tlOutSec: 6, states: [{ atSec: 4.5, params: {} }] },
        { id: "mark", component: "TextOverlay", params: {}, tlInSec: 0, tlOutSec: 9 },
      ],
      sfx: [{ id: "ding", src: "d.mp3", tlInSec: 5 }],
      music: [{ id: "bed", src: "m.mp3", tlInSec: 0, durationSec: 9, duckWindows: [{ tlInSec: 5.5, tlOutSec: 7 }] }],
      assets: {},
    });
    const cap = (e: Edl, id: string) => e.captions.find((c) => c.id === id)!;
    const ov = (e: Edl, id: string) => e.overlays.find((o) => o.id === id)!;
    const voice = (e: Edl, id: string) => e.voiceovers.find((v) => v.id === id)!;
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

    const longer = applyOp(doc, { type: "trimEdge", track: "video", id: "a", edge: "out", tlSec: 4 });
    t.check("growing a main-track clip pushes the clips after it", near(longer.video[1].tlInSec, 4) && near(longer.video[2].tlOutSec, 10));
    t.check("…and everything on the other layers after it, by the same amount", near(cap(longer, "cb").tlInSec, 4) && near(cap(longer, "cc").words[0].tlStartSec, 7) && near(voice(longer, "vc").tlInSec, 6.5) && near(longer.sfx[0].tlInSec, 6));
    t.check("an overlay keeps its length and its state changes move with it", near(ov(longer, "title").tlInSec, 5) && near(ov(longer, "title").tlOutSec, 7) && near(ov(longer, "title").states[0].atSec, 5.5));
    t.check("a voice line's generated position moves with it, so it does not read as moved", near(voice(longer, "vc").original!.tlInSec, 6.5));
    t.check("what sits on the edited clip itself stays put", near(cap(longer, "ca").tlInSec, 0.5) && near(voice(longer, "va").tlInSec, 0.5));
    t.check("a bed and a watermark over the whole video stretch with it", near(longer.music[0].durationSec!, 10) && near(ov(longer, "mark").tlOutSec, 10) && near(longer.durationSec, 10));
    t.check("a duck window moves with the line it ducks under", near(longer.music[0].duckWindows[0].tlInSec, 6.5));

    const shorter = applyOp(doc, { type: "trimEdge", track: "video", id: "a", edge: "out", tlSec: 2 });
    t.check("shrinking pulls everything after it back", near(cap(shorter, "cb").tlInSec, 2) && near(voice(shorter, "vc").tlInSec, 4.5) && near(shorter.durationSec, 8));
    const trimmedIn = applyOp(doc, { type: "trimEdge", track: "video", id: "a", edge: "in", tlSec: 1 });
    t.check("trimming a clip's start ripples the same way (the clip stays at its place)", near(trimmedIn.video[0].tlInSec, 0) && near(cap(trimmedIn, "cb").tlInSec, 2));

    // Changing a clip's speed.
    const slow = applyOp(doc, { type: "setSpeed", id: "a", speed: 0.5 });
    t.check("a slower clip gets longer and keeps its source range", near(slow.video[0].tlOutSec, 6) && near(slow.video[0].srcOutSec, 3) && slow.video[0].speed === 0.5);
    t.check("the track behind a slowed clip moves later and keeps its lengths", near(slow.video[1].tlInSec, 6) && near(slow.video[1].tlOutSec - slow.video[1].tlInSec, 2) && near(slow.video[2].tlInSec, 8) && near(slow.durationSec, 12));
    t.check("a caption inside the clip stretches with it, words included", near(cap(slow, "ca").tlInSec, 1) && near(cap(slow, "ca").tlOutSec, 2) && near(cap(slow, "ca").words[0].tlStartSec, 1) && near(cap(slow, "ca").words[0].tlEndSec, 2));
    t.check("a caption on a later clip moves by the clip's growth, unstretched", near(cap(slow, "cb").tlInSec, 6) && near(cap(slow, "cb").tlOutSec, 7) && near(cap(slow, "cc").tlInSec, 9));
    t.check("a watermark over the whole video follows the new end, not the clip's stretch", near(ov(slow, "mark").tlInSec, 0) && near(ov(slow, "mark").tlOutSec, 12));
    const quick = applyOp(doc, { type: "setSpeed", id: "a", speed: 2 });
    t.check("a faster clip is shorter and the track closes up behind it", near(quick.video[0].tlOutSec, 1.5) && near(quick.video[1].tlInSec, 1.5) && near(quick.durationSec, 7.5));
    t.check("back to normal speed restores the length", near(applyOp(slow, { type: "setSpeed", id: "a", speed: 1 }).video[0].tlOutSec, 3));
    t.check("speed changes the clip you picked and no other", slow.video[1].speed === 1.5 && slow.video[2].speed === 1);
    t.throws("a speed of zero is an error", () => applyOp(doc, { type: "setSpeed", id: "a", speed: 0 }));
    t.throws("a speed past the limit is an error", () => applyOp(doc, { type: "setSpeed", id: "a", speed: 10 }));
    t.throws("a clip that is not on the timeline is an error", () => applyOp(doc, { type: "setSpeed", id: "zzz", speed: 1.2 }), /no video clip|video clip/);

    const fast = applyOp(doc, { type: "trimEdge", track: "video", id: "b", edge: "out", tlSec: 6 });
    t.check("a sped-up clip is trimmed in timeline seconds, and the clips after it keep their length", near(fast.video[1].tlOutSec, 6) && near(fast.video[1].srcOutSec, 4.5) && near(fast.video[2].tlOutSec - fast.video[2].tlInSec, 4));
    const split = applyOp(doc, { type: "split", track: "video", id: "b", atSec: 4 });
    const splitA = applyOp(doc, { type: "split", track: "video", id: "a", atSec: 1 });
    t.check("splitting a clip moves nothing, even on the half that got a new id", JSON.stringify(splitA.video.map((v) => [v.tlInSec, v.tlOutSec])) === "[[0,1],[1,3],[3,5],[5,9]]" && near(voice(splitA, "va").tlInSec, 0.5) && near(cap(splitA, "cb").tlInSec, 3) && splitA.captions.every((c, i) => near(c.tlInSec, doc.captions[i].tlInSec)) && splitA.voiceovers.every((v, i) => near(v.tlInSec, doc.voiceovers[i].tlInSec)));
    const inserted = applyOp(doc, { type: "addVideo", src: "n.mp4", durationSec: 2, atIndex: 1 });
    t.check("a clip inserted on the main track pushes the layers after the cut", near(cap(inserted, "ca").tlInSec, 0.5) && near(cap(inserted, "cb").tlInSec, 5) && near(voice(inserted, "vc").tlInSec, 7.5));
    t.check("splitting a sped-up clip moves nothing either", JSON.stringify(split.video.map((v) => [v.tlInSec, v.tlOutSec])) === "[[0,3],[3,4],[4,5],[5,9]]" && near(cap(split, "cc").tlInSec, 6));

    const gone = applyOp(doc, { type: "delete", track: "video", id: "b" });
    t.check("deleting a clip closes the gap for every layer", near(cap(gone, "cc").tlInSec, 4) && near(voice(gone, "vc").tlInSec, 3.5));
    t.check("what started on the deleted clip lands where the gap closed", near(cap(gone, "cb").tlInSec, 3) && near(ov(gone, "title").tlInSec, 3));

    const reordered = applyOp(doc, { type: "reorder", id: "c", toIndex: 0 });
    t.check("reordering takes a clip's layers along with it", near(voice(reordered, "vc").tlInSec, 0.5) && near(cap(reordered, "ca").tlInSec, 4.5));

    const lifted = applyOp(doc, { type: "videoToOverlay", id: "b", tlInSec: 7 });
    t.check("a clip lifted onto a layer stays where it was dropped", near(ov(lifted, "b").tlInSec, 7) && near(cap(lifted, "cc").tlInSec, 4));

    const untouched = applyOp(doc, { type: "move", track: "captions", id: "cc", tlInSec: 7 });
    t.check("an edit off the main track moves nothing else", near(voice(untouched, "vc").tlInSec, 5.5) && near(untouched.durationSec, 9));
  }

  {
    // A music-only source: no lines, and a 0.1s flash cut between two shots.
    const silentSpec = { media: { durationSec: 3, width: 720, height: 1280, fps: 30 }, speech: { lines: [], wordsPerMin: 0 }, shots: [{ id: "s0", startSec: 0, endSec: 1.4 }, { id: "s1", startSec: 1.4, endSec: 1.5 }, { id: "s2", startSec: 1.5, endSec: 3 }] } as unknown as RecreationSpec;
    const silentScript = { lines: [], shots: [shot("s0", "character_talking"), shot("s1", "character_talking"), shot("s2", "screen_fill")] } as unknown as AdaptedScript;
    const silent = buildNativeTimeline(silentScript, silentSpec);
    t.check("a music-only source has a timeline with no lines", silent.lines.length === 0 && silent.shots.length === 3);
    t.check("in a music-only video nobody speaks, so no shot pays for a talking clip", speakingShots(silent).size === 0 && silentScript.shots.every((sh) => planClip(sh, speakingShots(silent).has(sh.shotId)) !== "talking"));
    t.check("a flash cut shorter than the minimum is stretched to it, not refused", near(silent.shots[1].tlOutSec - silent.shots[1].tlInSec, MIN_SHOT_SEC, 1e-9) && near(silent.durationSec, 1.4 + MIN_SHOT_SEC + 1.5, 1e-9));
  }

  {
    // The per-video cost report: every call in order, totals by step and provider, unpriced calls flagged.
    const log = [
      JSON.stringify({ at: "2026-10-07T10:00:00.000Z", provider: "anthropic", model: "claude-opus-5-5", operation: "adapt", ref: "b/c", units: {}, usd: 0.0123 }),
      JSON.stringify({ at: "2026-10-07T10:01:00.000Z", provider: "google", model: "gemini-3-pro-image", operation: "storyboard_frame", usd: 0.134 }),
      JSON.stringify({ at: "2026-10-07T10:01:05.000Z", provider: "google", model: "gemini-3-pro-image", operation: "storyboard_frame", usd: 0.134 }),
      JSON.stringify({ at: "2026-10-07T10:02:00.000Z", provider: "higgsfield", model: "m", operation: "motion_transfer_shot", usd: 0, note: "price unknown" }),
      '{"usd": 9',
      "",
    ].join("\n");
    const entries = parseCostLog(log);
    t.check("a half-written last line and blanks are skipped", entries.length === 4);
    const report = costReport("b/c", entries);
    t.check("the report totals every call", report.includes("TOTAL $0.2803 across 4 paid calls"));
    t.check("the report groups calls by step", report.includes("2 calls  google/storyboard_frame") && report.includes("1 call   anthropic/adapt"));
    t.check("a call with no price is flagged, not passed off as free", report.includes("(unpriced: price unknown)") && report.includes("1 call has no price"));
    t.check("a video with no paid calls says so", costReport("b/c", []).includes("no paid calls recorded"));
  }

  t.finish("production");
};

main();

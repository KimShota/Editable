import type { VideoAnalysis } from "../../analysis/schemas";
import { makeChecker } from "../../tools/checks";
import { assembleSpec, buildDecompositionText, type Keyframe, keyframeTimes, sourceIdFromUrl } from "../decompose";
import { assembleScript, buildAdaptText } from "../adapt";
import { type Adaptation, AdaptedScriptSchema, type Decomposition, type ProductFootage, RecreationSpecSchema } from "../schemas";

/**
 * The RecreationSpec and AdaptedScript assembly, with no network and no API key: a hand-built
 * analysis and decomposition stand in for the analyzer and Claude.
 *
 *   npm run test:recreation
 */

const word = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });

const analysis = {
  media: { durationSec: 10, width: 720, height: 1280, fps: 30, hasAudio: true },
  shots: [
    { startSec: 0, endSec: 3 },
    { startSec: 3, endSec: 7 },
    { startSec: 7, endSec: 10 },
  ],
  transcript: {
    words: [word("Stop", 0, 0.5), word("scrolling.", 0.5, 1), word("Open", 3.2, 3.6), word("the", 3.6, 3.8), word("app.", 3.8, 4.2), word("Comment", 7.5, 8), word("now.", 8, 8.5)],
    wordsPerMin: 42,
  },
  captions: { measured: true, coverage: 0.7, medianWords: 3, position: "middle", mode: "full" },
  audio: { speechRatio: 0.9, musicRatio: 0.05, beat: { bpm: null, confidence: 0, beatTimesSec: [] } },
} as unknown as VideoAnalysis;

const shotLabel = (shotIndex: number, kind: Decomposition["shots"][number]["kind"]): Decomposition["shots"][number] => ({
  shotIndex,
  kind,
  framing: "medium",
  camera: "static",
  subject: "x",
  setting: "x",
  productPresence: "none",
  speaker: kind === "talking" ? "on_camera" : "voiceover",
  textOnScreen: [],
});

const decomposition: Decomposition = {
  language: "en",
  topic: "t",
  whyItWorks: "w",
  hook: "h",
  soundDependent: false,
  structure: [
    { beat: "hook", shotIndices: [0], purpose: "p" },
    { beat: "demo", shotIndices: [1, 9], purpose: "p" },
    { beat: "cta", shotIndices: [2], purpose: "p" },
  ],
  shots: [shotLabel(2, "talking"), shotLabel(0, "talking"), shotLabel(1, "screen")],
  // Out of order, a duplicate start, and the first line not starting at 0:
  // assembly must still tile the transcript.
  speechLines: [
    { fromWord: 5, toWord: 6, role: "cta" },
    { fromWord: 2, toWord: 4, role: "demo" },
    { fromWord: 2, toWord: 3, role: "demo" },
    { fromWord: 1, toWord: 1, role: "hook" },
  ],
  captionStyle: { present: true, mode: "phrase", position: "middle", look: "white" },
};

const keyframes: Keyframe[] = [
  { shotIndex: 0, atSec: 1.5, path: "/x", key: "k0" },
  { shotIndex: 1, atSec: 4, path: "/x", key: "k1" },
];
const meta = { sourceId: "abc", url: null, creator: null, likes: 1, comments: 2, views: null };

const main = () => {
  const t = makeChecker();

  t.check("short shots get one keyframe", keyframeTimes(0, 2).length === 1);
  t.check("long shots get three keyframes inside the shot", (() => {
    const ts = keyframeTimes(10, 30);
    return ts.length === 3 && ts.every((x) => x > 10 && x < 30);
  })());

  t.check("instagram reel id", sourceIdFromUrl("https://www.instagram.com/reel/Dd39AI5vNUy/?stkn=x") === "Dd39AI5vNUy");
  t.check("tiktok video id", sourceIdFromUrl("https://www.tiktok.com/@a/video/7312345678901234567") === "7312345678901234567");
  t.check("youtube shorts id", sourceIdFromUrl("https://youtube.com/shorts/aB3_cd-ef") === "aB3_cd-ef");
  t.check("unknown URLs hash to a stable id", sourceIdFromUrl("https://x.test/v") === sourceIdFromUrl("https://x.test/v") && /^[0-9a-f]{12}$/.test(sourceIdFromUrl("https://x.test/v")));

  const text = buildDecompositionText(analysis);
  t.check("prompt numbers the transcript", text.includes("[0] Stop") && text.includes("[6] now."));
  t.check("prompt gives the measured shot times", text.includes("shot 1: 3.00–7.00s"));

  const spec = RecreationSpecSchema.parse(assembleSpec(analysis, decomposition, keyframes, meta, "m"));
  t.check("shots come back in measured order with measured times", spec.shots.map((s) => `${s.id}:${s.startSec}-${s.endSec}:${s.kind}`).join(" ") === "s0:0-3:talking s1:3-7:screen s2:7-10:talking");
  t.check("keyframes attach to their shot", spec.shots[0].keyframes[0].key === "k0" && spec.shots[2].keyframes.length === 0);
  t.check("lines tile the transcript from word 0", spec.speech.lines.map((l) => l.text).join(" | ") === "Stop | scrolling. | Open the app. | Comment now.", spec.speech.lines.map((l) => l.text).join(" | "));
  t.check("line times come from the words, not the model", spec.speech.lines[2].startSec === 3.2 && spec.speech.lines[2].endSec === 4.2);
  t.check("lines know which shots they play over", spec.speech.lines[2].shotIds.join() === "s1" && spec.speech.lines[3].shotIds.join() === "s2");
  t.check("out-of-range beat shots are dropped", spec.structure[1].shotIndices.join() === "1");
  t.check("the audio bed is measured", spec.audioBed.musicRatio === 0.05 && spec.audioBed.bpm === null);

  t.throws("a missing shot label is an error, not a guess", () => assembleSpec(analysis, { ...decomposition, shots: decomposition.shots.slice(1) }, keyframes, meta, "m"), /one label per shot/);

  // Adapting the spec for a brand.
  const footage: ProductFootage = { clips: [{ id: "draft", key: "k", startSec: 0, endSec: 3, shows: "the reply drafts itself" }] };
  const shotPlan = (shotId: string, footageId: string | null = null): Adaptation["shots"][number] => ({
    shotId,
    treatment: footageId ? "device_closeup" : "character_talking",
    action: "a",
    footageId,
    otherScreen: null,
    textOnScreen: [],
  });
  const adaptation: Adaptation = {
    angle: "a",
    ctaKeyword: "SHOGUN",
    lines: [
      { index: 2, text: "Press Option." },
      { index: 0, text: "REWRITTEN HOOK" },
      { index: 1, text: "  Wait  for it. " },
      { index: 3, text: "Comment SHOGUN." },
    ],
    shots: [shotPlan("s0"), shotPlan("s1", "draft"), shotPlan("s2")],
    postCaption: "c",
    hashtags: ["#ai", "mac", "a", "b", "c", "d"],
  };
  const script = AdaptedScriptSchema.parse(assembleScript(spec, adaptation, footage, { brand: "b", language: "en", keep: [0] }, "m"));
  t.check("kept lines are restored from the source, not trusted", script.lines[0].text === "Stop" && script.lines[0].kept && !script.lines[1].kept);
  t.check("lines come back in source order with source roles", script.lines.map((l) => `${l.index}:${l.role}`).join() === "0:hook,1:hook,2:demo,3:cta");
  t.check("word counts are measured on the rewrite", script.lines[1].text === "Wait  for it." && script.lines[1].wordCount === 3 && script.lines[1].sourceWordCount === 1);
  t.check("shots keep the source timing", script.shots[1].sourceStartSec === 3 && script.shots[1].sourceKind === "screen" && script.shots[1].footageId === "draft");
  t.check("hashtags lose the # and stop at 5", script.hashtags.join() === "ai,mac,a,b,c");
  t.throws("a missing line is an error", () => assembleScript(spec, { ...adaptation, lines: adaptation.lines.slice(1) }, footage, { brand: "b", language: "en" }, "m"), /one line per source line/);
  t.throws("a missing shot is an error", () => assembleScript(spec, { ...adaptation, shots: adaptation.shots.slice(1) }, footage, { brand: "b", language: "en" }, "m"), /one entry per source shot/);
  t.throws("product UI only from real footage", () => assembleScript(spec, { ...adaptation, shots: [shotPlan("s0"), shotPlan("s1", "made-up"), shotPlan("s2")] }, footage, { brand: "b", language: "en" }, "m"), /unknown footage/);
  t.throws("an out-of-range keep is an error", () => assembleScript(spec, adaptation, footage, { brand: "b", language: "en", keep: [9] }, "m"), /out of range/);

  const intake = {
    companyName: "Co",
    products: [{ name: "Prod", oneLiner: "o", features: ["drafts replies"], priceNote: null, audience: "founders" }],
    recommendedProductIndex: 0,
    audience: "x",
    tone: ["calm"],
    language: "en",
  } as unknown as Parameters<typeof buildAdaptText>[1];
  const character = {
    concept: { name: "Rin", form: "f", oneLine: "o", personality: ["p"], signatureProp: "laptop", catchphrase: "c" },
  } as unknown as Parameters<typeof buildAdaptText>[2];
  const prompt = buildAdaptText(spec, intake, character, footage, { keep: [0], cta: "SHOGUN" });
  t.check("adapt prompt marks kept lines and lists the footage", prompt.includes('[0] hook · 1 words · 0.0s · KEEP VERBATIM: "Stop"') && prompt.includes("draft (3.0s)"));
  t.check("adapt prompt names the skeleton and the keyword", prompt.includes("indices 0-3") && prompt.includes("s0, s1, s2") && prompt.includes('"SHOGUN"'));

  t.finish("recreation");
};

main();

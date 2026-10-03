import { type AdaptedScript, AdaptedScriptSchema, type RecreationSpec, RecreationSpecSchema } from "../../recreation/schemas";

/**
 * A small but complete RecreationSpec and AdaptedScript, built in code and
 * parsed through the real schemas so they can never drift from them. Used by
 * the stub providers (no paid calls) and by the browser-test fixture.
 */

const SHOTS = [
  { id: "s0", startSec: 0, endSec: 3, kind: "talking" as const, subject: "A presenter speaks to camera", text: "" },
  { id: "s1", startSec: 3, endSec: 7, kind: "screen" as const, subject: "A laptop screen shows the app", text: "Step one" },
  { id: "s2", startSec: 7, endSec: 10, kind: "talking" as const, subject: "The presenter points at the screen", text: "Comment GO" },
];

export const fixtureSpec = (sourceId: string, over: { topic?: string; hook?: string; brand?: string } = {}): RecreationSpec =>
  RecreationSpecSchema.parse({
    sourceId,
    sourceUrl: `https://www.instagram.com/reel/${sourceId}/`,
    creator: "someone",
    engagement: { likes: 1200, comments: 80, views: 54000 },
    media: { durationSec: 10, width: 720, height: 1280, fps: 30 },
    language: "en",
    topic: over.topic ?? `Topic of ${sourceId}`,
    whyItWorks: "A bold claim up front, quick steps, and a comment keyword to finish.",
    hook: over.hook ?? "A bold claim to camera",
    soundDependent: false,
    structure: [
      { beat: "hook", shotIndices: [0], purpose: "Make the claim." },
      { beat: "demo", shotIndices: [1], purpose: "Show it working." },
      { beat: "cta", shotIndices: [2], purpose: "Ask for the comment." },
    ],
    shots: SHOTS.map((s) => ({
      id: s.id,
      startSec: s.startSec,
      endSec: s.endSec,
      kind: s.kind,
      framing: "medium",
      camera: "static",
      subject: s.subject,
      setting: "a bright room",
      productPresence: s.kind === "screen" ? "screen" : "none",
      speaker: s.kind === "screen" ? "voiceover" : "on_camera",
      textOnScreen: s.text ? [{ text: s.text, role: "label", position: "bottom" }] : [],
      keyframes: [{ atSec: (s.startSec + s.endSec) / 2, key: `brands/${over.brand ?? "acme"}/sources/keyframes/${sourceId}/${s.id}.jpg` }],
    })),
    speech: {
      lines: [
        { text: "Here is the thing nobody tells you.", startSec: 0, endSec: 3, role: "hook", shotIds: ["s0"], wordCount: 7 },
        { text: "Open the app and let it do the work for you.", startSec: 3, endSec: 7, role: "demo", shotIds: ["s1"], wordCount: 10 },
        { text: "Comment GO and I will send you the guide.", startSec: 7, endSec: 10, role: "cta", shotIds: ["s2"], wordCount: 9 },
      ],
      wordsPerMin: 150,
    },
    captionStyle: { present: true, mode: "phrase", position: "middle", look: "white bold sans-serif" },
    audioBed: { musicRatio: 0.2, speechRatio: 0.7, bpm: null, beatTimesSec: [] },
    createdAt: "2026-10-03T00:00:00.000Z",
    model: "fixture",
  });

export const fixtureScript = (brand: string, sourceId: string, over: { angle?: string; lines?: string[] } = {}): AdaptedScript => {
  const texts = over.lines ?? ["Here is what I wish I knew about this product.", "Open it and it handles the busywork for you.", "Comment GO and I will send you the guide."];
  const spec = fixtureSpec(sourceId, { brand });
  return AdaptedScriptSchema.parse({
    sourceId,
    brand,
    language: "en",
    angle: over.angle ?? `An angle for ${sourceId}`,
    ctaKeyword: "GO",
    lines: spec.speech.lines.map((l, i) => ({
      index: i,
      text: texts[i],
      role: l.role,
      sourceText: l.text,
      kept: false,
      shotIds: l.shotIds,
      wordCount: texts[i].split(/\s+/).length,
      sourceWordCount: l.wordCount,
    })),
    shots: spec.shots.map((s) => ({
      shotId: s.id,
      treatment: s.kind === "screen" ? "screen_fill" : "character_talking",
      action: s.kind === "screen" ? "The product on a laptop screen" : "The character speaks to camera",
      footageId: null,
      otherScreen: null,
      textOnScreen: s.textOnScreen,
      sourceStartSec: s.startSec,
      sourceEndSec: s.endSec,
      sourceKind: s.kind,
    })),
    postCaption: "A caption for the post.",
    hashtags: ["ai", "tips"],
    createdAt: "2026-10-03T00:00:00.000Z",
    model: "fixture",
  });
};

import { z } from "zod";

/**
 * RecreationSpec: one viral source video, decomposed so it can be remade
 * with a brand's character and product (plan section 3.2). Timings are
 * MEASURED by the analyzer (shot boundaries, word times); Claude only
 * labels what each shot is and how the video is built, never a timestamp.
 */

export const ShotKindSchema = z
  .enum(["talking", "motion", "product", "screen", "broll", "text_only"])
  .describe(
    "talking: a person speaks to camera. motion: the movement itself is the point (dance, gesture trend). " +
      "product: a physical product is shown or used. screen: a phone/tablet/computer screen is the subject (UI, app, website), with or without a hand. " +
      "broll: atmosphere or illustration with no one speaking to camera. text_only: a text card or graphic with no live footage.",
  );

export const FramingSchema = z.enum(["extreme_close", "close", "medium", "wide", "over_shoulder", "screen_fill"]);
export const CameraSchema = z.enum(["static", "handheld", "push_in", "pull_out", "pan", "tilt", "selfie_handheld"]);

const TextOnScreenSchema = z.object({
  text: z.string().describe("The text exactly as shown, without emoji."),
  role: z.enum(["hook_title", "label", "cta", "other"]).describe("hook_title: the big title of the opening. label: names or numbers explaining a step. cta: the call to action."),
  position: z.enum(["top", "middle", "bottom"]),
});

/** What Claude returns for one source video. */
export const DecompositionSchema = z.object({
  language: z.string().describe("Spoken language, BCP-47 (e.g. en, ja)."),
  topic: z.string().describe("What the video is about, under 12 words."),
  whyItWorks: z.string().describe("2-3 sentences: the hook mechanism, the pacing, the payoff, and why people comment or share."),
  hook: z.string().describe("How the first 3 seconds grab attention, in one sentence."),
  soundDependent: z.boolean().describe("True only if the video relies on a trending sound or song rather than its own voice."),
  structure: z
    .array(
      z.object({
        beat: z.enum(["hook", "setup", "problem", "demo", "proof", "payoff", "cta"]),
        shotIndices: z.array(z.number().int()),
        purpose: z.string().describe("What this part does for the viewer, one sentence."),
      }),
    )
    .describe("The video's beats in order; every shot belongs to exactly one beat."),
  shots: z
    .array(
      z.object({
        shotIndex: z.number().int(),
        kind: ShotKindSchema,
        framing: FramingSchema,
        camera: CameraSchema,
        subject: z.string().describe("Who or what is on screen and what they do, one sentence. For screen shots, name the app or site shown and what the hand does."),
        setting: z.string().describe("Where it is filmed, in a few words."),
        productPresence: z.enum(["none", "held", "used", "hero", "screen"]),
        speaker: z.enum(["on_camera", "voiceover", "none"]).describe("on_camera: the visible person's lips match the speech. voiceover: speech over footage of something else."),
        textOnScreen: z.array(TextOnScreenSchema).describe("Burned-in titles, labels and CTAs. Do NOT list the auto-captions that transcribe the speech word by word."),
      }),
    )
    .describe("Exactly one entry per measured shot, in order."),
  speechLines: z
    .array(
      z.object({
        fromWord: z.number().int().describe("Index of the first word of the line in the numbered transcript."),
        toWord: z.number().int().describe("Index of the last word (inclusive)."),
        role: z.enum(["hook", "setup", "problem", "demo", "proof", "payoff", "cta"]),
      }),
    )
    .describe("The transcript split into spoken lines (a sentence or a breath each), contiguous and in order, covering every word."),
  captionStyle: z.object({
    present: z.boolean().describe("Whether the speech is auto-captioned on screen."),
    mode: z.enum(["word_by_word", "phrase", "full_sentence", "none"]),
    position: z.enum(["top", "middle", "bottom"]),
    look: z.string().describe("Font, colour, outline/shadow, highlight, in a few words."),
  }),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;

export const RecreationSpecSchema = z.object({
  sourceId: z.string(),
  sourceUrl: z.string().nullable(),
  creator: z.string().nullable(),
  engagement: z.object({ likes: z.number().nullable(), comments: z.number().nullable(), views: z.number().nullable() }),
  media: z.object({ durationSec: z.number(), width: z.number(), height: z.number(), fps: z.number() }),
  language: z.string(),
  topic: z.string(),
  whyItWorks: z.string(),
  hook: z.string(),
  soundDependent: z.boolean(),
  structure: DecompositionSchema.shape.structure,
  shots: z.array(
    DecompositionSchema.shape.shots.element.omit({ shotIndex: true }).extend({
      id: z.string(),
      startSec: z.number(),
      endSec: z.number(),
      /** storage keys of keyframes pulled from the source (composition reference). */
      keyframes: z.array(z.object({ atSec: z.number(), key: z.string() })),
    }),
  ),
  speech: z.object({
    lines: z.array(
      z.object({
        text: z.string(),
        startSec: z.number(),
        endSec: z.number(),
        role: DecompositionSchema.shape.speechLines.element.shape.role,
        shotIds: z.array(z.string()),
        wordCount: z.number().int(),
      }),
    ),
    wordsPerMin: z.number().nullable(),
  }),
  captionStyle: DecompositionSchema.shape.captionStyle,
  audioBed: z.object({
    musicRatio: z.number().nullable(),
    speechRatio: z.number().nullable(),
    bpm: z.number().nullable(),
    beatTimesSec: z.array(z.number()),
  }),
  createdAt: z.string(),
  model: z.string(),
});
export type RecreationSpec = z.infer<typeof RecreationSpecSchema>;

import { z } from "zod";

/**
 * The brand character (plan decisions 2–3): one per brand, realistic or
 * mascot, designed once and then LOCKED. Every later generation (storyboard
 * stills, shots) uses the locked sheet as its reference images, which is
 * the whole consistency mechanism (decision 18: reference images, no LoRA).
 */

export const CharacterStyleSchema = z.enum(["3d_render", "2d_flat", "anime", "claymation", "plush", "pixel"]);

export const MascotConceptSchema = z.object({
  name: z.string().describe("The mascot's own name: short, sayable, memorable."),
  form: z.string().describe('What it is, e.g. "a small castle-keep guardian owl".'),
  style: CharacterStyleSchema,
  oneLine: z.string().describe("The concept in one sentence, as you would pitch it to the brand."),
  personality: z.array(z.string()).describe("3-5 traits that show up in how it acts on camera."),
  appearance: z
    .string()
    .describe("A precise visual description an image model can draw consistently: silhouette, proportions, colours as hex from the brand kit, materials, eyes, distinctive marks. No text or logos on the character."),
  signatureProp: z.string().describe("One recurring object it carries or uses, tied to the product."),
  catchphrase: z.string().describe("A short recurring line for video openers or sign-offs."),
  voiceDescription: z.string().describe("How it sounds, for a voice-design model: age, pitch, pace, accent, energy, texture."),
  whyItFits: z.string().describe("Why this character makes the brand recognizable and fits the product."),
  contentAngle: z.string().describe("The kind of daily short-form videos this character naturally stars in."),
});

export const MascotConceptsSchema = z.object({
  concepts: z.array(MascotConceptSchema),
});

export type CharacterStyle = z.infer<typeof CharacterStyleSchema>;
export type MascotConcept = z.infer<typeof MascotConceptSchema>;

/** The views every locked mascot sheet contains. Each is generated from the
 *  chosen base image as a reference, so they stay on-model. */
export const SHEET_VIEWS = {
  front: "full body, standing, facing the camera directly, neutral friendly expression, arms relaxed",
  three_quarter: "full body, turned three-quarters to its left, same pose otherwise",
  side: "full body, strict side profile facing left",
  back: "full body, seen from directly behind",
  happy: "waist-up, delighted expression, big smile, one hand raised in a wave",
  surprised: "waist-up, surprised expression, eyes wide, mouth open, leaning back slightly",
  thinking: "waist-up, thinking expression, looking up and to the side, hand on chin",
  presenting: "waist-up, enthusiastically presenting something to its right with an open hand, talking to camera",
  with_prop: "full body, holding and showing its signature prop to the camera",
} as const;

export type SheetView = keyof typeof SHEET_VIEWS;

export const LockedCharacterSchema = z.object({
  kind: z.enum(["realistic", "mascot"]),
  concept: MascotConceptSchema,
  /** storage key of the chosen base image every view was generated from. */
  baseImageKey: z.string(),
  /** view name → storage key. */
  sheet: z.record(z.string(), z.string()),
  lockedAt: z.string(),
  voice: z
    .object({
      provider: z.literal("elevenlabs"),
      voiceId: z.string(),
      name: z.string(),
      source: z.enum(["library", "designed"]),
      sampleKey: z.string().nullable(),
    })
    .nullable(),
});

export type LockedCharacter = z.infer<typeof LockedCharacterSchema>;

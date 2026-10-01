import { googleImageCostEntry, type CostSink } from "../cost/ledger";
import { GEMINI_IMAGE_MODEL, generateImage } from "../pipeline/generation/geminiImage";
import { type MascotConcept, SHEET_VIEWS, type SheetView } from "./schemas";

/**
 * Mascot images: candidates from a concept (text only), then the locked
 * sheet, every view generated with the chosen candidate as its reference
 * image so the character stays on-model.
 *
 * Gemini 3 Pro Image here rather than Higgsfield: stills with strong
 * reference-image adherence are this step's whole job, and that model is
 * the one in the repo that takes several references per call.
 */

const STYLE_WORDS: Record<MascotConcept["style"], string> = {
  "3d_render": "polished 3D animated-film character render, soft global illumination, subtle subsurface scattering",
  "2d_flat": "clean 2D flat vector illustration, bold simple shapes, minimal shading",
  anime: "anime-style character illustration, clean line art, cel shading",
  claymation: "stop-motion claymation character, handmade clay texture, soft studio light",
  plush: "soft plush toy character, felt and fabric texture, studio product lighting",
  pixel: "high-detail pixel art character",
};

const SHARED_RULES =
  "Plain seamless light-grey studio background. The whole character is in frame with margin around it. " +
  "No text, no letters, no logos, no watermark, no other characters, no props other than the ones described.";

export const candidatePrompt = (concept: MascotConcept, variation?: string): string =>
  [
    `Character design for a brand mascot named ${concept.name}: ${concept.form}.`,
    `Appearance: ${concept.appearance}`,
    `Personality to read in the pose and face: ${concept.personality.join(", ")}.`,
    `Style: ${STYLE_WORDS[concept.style]}.`,
    "Full body, standing, facing the camera, friendly neutral expression, centered.",
    variation ? `Variation: ${variation}` : "",
    SHARED_RULES,
  ]
    .filter(Boolean)
    .join(" ");

export const refinePrompt = (concept: MascotConcept, note: string, hasFeatureRef = false): string =>
  [
    `This is ${concept.name}, a brand mascot (${concept.form}). Redraw the SAME character from the first reference image with one change: ${note}.`,
    hasFeatureRef
      ? "The second reference image shows the feature to borrow and nothing else: take only the shape of that feature, translated into the mascot's own style, materials and colours. Do not copy its realism, lighting, setting, body, colours or mood."
      : "",
    "Keep everything not mentioned identical: silhouette, proportions, colours, materials, style.",
    "Full body, standing, facing the camera, centered.",
    SHARED_RULES,
  ]
    .filter(Boolean)
    .join(" ");

export const sheetViewPrompt = (concept: MascotConcept, view: SheetView): string =>
  [
    `This is ${concept.name}, a brand mascot (${concept.form}), shown in the reference image.`,
    `Draw exactly this same character — identical silhouette, proportions, colours, face, materials and ${STYLE_WORDS[concept.style]} style — in a new pose: ${SHEET_VIEWS[view]}.`,
    view === "with_prop" ? `The signature prop: ${concept.signatureProp}.` : "",
    "Character model sheet consistency matters more than anything else.",
    SHARED_RULES,
  ]
    .filter(Boolean)
    .join(" ");

type ImageOptions = { costSink?: CostSink; ref?: string };

const record = async (opts: ImageOptions, operation: string) =>
  opts.costSink?.(googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, operation, { ref: opts.ref }));

export const generateCandidate = async (concept: MascotConcept, variation: string | undefined, opts: ImageOptions = {}): Promise<Buffer> => {
  const bytes = await generateImage(candidatePrompt(concept, variation), [], 0, { aspectRatio: "1:1", imageSize: "2K" });
  await record(opts, "mascot_candidate");
  return bytes;
};

/** `featureRefPath`: an optional second image showing the feature the note
 *  asks for (e.g. a face shape from a meme), borrowed in shape only. */
export const refineCandidate = async (
  concept: MascotConcept,
  basePath: string,
  note: string,
  opts: ImageOptions & { featureRefPath?: string } = {},
): Promise<Buffer> => {
  const refs = opts.featureRefPath ? [basePath, opts.featureRefPath] : [basePath];
  const bytes = await generateImage(refinePrompt(concept, note, refs.length > 1), refs, refs.length, { aspectRatio: "1:1", imageSize: "2K" });
  await record(opts, "mascot_refine");
  return bytes;
};

export const generateSheetView = async (concept: MascotConcept, basePath: string, view: SheetView, opts: ImageOptions = {}): Promise<Buffer> => {
  const bytes = await generateImage(sheetViewPrompt(concept, view), [basePath], 1, { aspectRatio: "1:1", imageSize: "2K" });
  await record(opts, `mascot_sheet_${view}`);
  return bytes;
};

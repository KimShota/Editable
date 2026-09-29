import { embeddingOf, vectorFromFeatures } from "../style/vector";
import type { StyleFeatures } from "./schemas";

/**
 * A video's stored style embedding: its StyleFeatures projected into the
 * shared style space (style/vector.ts). Lives here, not in style/, because
 * it is the analysis side of the projection — but it uses the very same
 * dimensions and normalization a StyleSpec does, which is the point.
 *
 * Unknown dimensions (a video with no transcript, no captions measured, no
 * grade delta) are filled with priors for the stored vector; the analysis
 * row keeps the honest nulls in style_features.
 */
export const deriveVideoEmbedding = (features: StyleFeatures): number[] => embeddingOf(vectorFromFeatures(features));

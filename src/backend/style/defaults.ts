import { GradeSchema } from "../pipeline/schemas";
import { StyleSpec, StyleSpecSchema } from "./schemas";

/**
 * A neutral, fully-valid StyleSpec built from typical short-form values
 * (the priors in dims.ts). It is the starting point when nothing is known —
 * a brand-new creator, or a field an extraction couldn't observe (plan
 * section 8: "use priors until the NLE feedback loop fills them in").
 *
 * It is a baseline to be overwritten by measurement, not a recommendation:
 * nothing about it says this is a GOOD style.
 */
export const neutralStyleSpec = (source: StyleSpec["source"]): StyleSpec =>
  StyleSpecSchema.parse({
    version: 1,
    source,
    pacing: {
      cutLenSec: {
        byClipKind: {
          talking: { p10: 1.2, p50: 3.5, p90: 8 },
          action: { p10: 0.6, p50: 1.6, p90: 3.5 },
          static: { p10: 1.5, p50: 3, p90: 6 },
          broll: { p10: 0.6, p50: 1.4, p90: 3 },
        },
      },
      cutsPerMin: 15,
      hookSec: 2,
      totalSec: { p50: 30, min: 15, max: 60 },
      energyCurve: [],
    },
    inPoint: {
      byClipKind: {
        talking: { anchor: "firstWord", offsetSec: -0.15, sdSec: 0.1 },
        action: { anchor: "motionPeak", offsetSec: -0.3, sdSec: 0.2 },
        static: { anchor: "settle", offsetSec: 0, sdSec: 0.2 },
        broll: { anchor: "clipHead", offsetSec: 0.2, sdSec: 0.15 },
      },
    },
    structure: {
      hookPattern: "other",
      ctaPattern: "none",
      montage: { runRate: 0.15, runLenP50: 5, memberLenP50: 0.5 },
      longTake: { rate: 0.05, p50Sec: 9 },
    },
    transitions: [{ kind: "cut", rate: 1 }],
    camera: { punchInRate: 0.1, zoomScale: 1.2 },
    captions: {
      mode: "keyword",
      fontRef: null,
      colors: { text: "#ffffff" },
      position: "bottom",
      wordsPerGroup: 4,
      emphasis: "none",
    },
    overlays: { densityPerMin: 3, kinds: [] },
    audio: { musicEnergy: 0.4, ducking: 0.5, sfxPerMin: 10, sfxVocab: [], beatSync: 0.3 },
    grade: GradeSchema.parse({}),
  });

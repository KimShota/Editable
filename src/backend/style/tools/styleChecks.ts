import fs from "node:fs";
import path from "node:path";
import { StyleFeatures } from "../../analysis/schemas";
import { repoRoot } from "../../pipeline/paths";
import { makeChecker, near } from "../../tools/checks";
import { neutralStyleSpec } from "../defaults";
import { STYLE_DIM_COUNT, STYLE_DIMS, normalizeDim } from "../dims";
import { type StyleSpec, StyleSpecSchema } from "../schemas";
import { deriveEmbedding, styleDistance, vectorFromFeatures, vectorFromSpec, withEmbedding } from "../vector";

/**
 * StyleSpec schema, style-space and distance checks. Pure: no ffmpeg, no DB.
 *
 *   npm run test:style
 */

const features = (over: Partial<StyleFeatures> = {}): StyleFeatures => ({
  durationSec: 30,
  cutsPerMin: 15,
  cutLenP10: 0.8,
  cutLenP50: 2.5,
  cutLenP90: 6,
  hookSec: 2,
  longTakeRate: 0.05,
  montageRunRate: 0.15,
  punchInRate: 0.1,
  zoomScale: 1.2,
  energy: 0.3,
  shake: 0.2,
  captionCoverage: 0.4,
  captionWords: 4,
  sfxPerMin: 10,
  musicRatio: 0.4,
  beatStrength: 0.3,
  speechRatio: 0.6,
  wordsPerMin: 150,
  loudnessMeanDb: -22,
  loudnessRangeDb: 20,
  lumaMean: 0.4,
  lumaSpread: 0.6,
  satMean: 0.4,
  warmth: 0,
  ...over,
});

const main = () => {
  const t = makeChecker();
  const source = { kind: "self" as const, ref: "user-1" };
  const spec = neutralStyleSpec(source);

  console.log("dimensions");
  t.check("keys are unique", new Set(STYLE_DIMS.map((d) => d.key)).size === STYLE_DIMS.length);
  t.check("every range is increasing and every prior is inside it", STYLE_DIMS.every((d) => d.lo < d.hi && d.prior >= d.lo && d.prior <= d.hi));
  t.check("log dimensions have a positive lower bound", STYLE_DIMS.filter((d) => d.scale === "log").every((d) => d.lo > 0));
  const cutLen = STYLE_DIMS.find((d) => d.key === "cutLenP50")!;
  t.check("normalize maps lo→0 and hi→1", normalizeDim(cutLen, cutLen.lo) === 0 && normalizeDim(cutLen, cutLen.hi) === 1);
  t.check("normalize clamps out-of-range", normalizeDim(cutLen, 1e6) === 1 && normalizeDim(cutLen, 1e-6) === 0);
  t.check("normalize returns null for NaN/Infinity", normalizeDim(cutLen, NaN) === null && normalizeDim(cutLen, Infinity) === null);
  const logMid = normalizeDim(cutLen, Math.sqrt(cutLen.lo * cutLen.hi));
  t.check("log scale puts the geometric mean at 0.5", logMid !== null && near(logMid, 0.5, 1e-9));

  console.log("migrations agree with the code");
  for (const file of ["011_videos_and_analyses.sql", "012_style_specs.sql"]) {
    const sqlText = fs.readFileSync(path.join(repoRoot, "db/migrations", file), "utf8");
    const widths = [...sqlText.matchAll(/vector\((\d+)\)/g)].map((m) => Number(m[1]));
    t.check(`${file} declares vector(${STYLE_DIM_COUNT})`, widths.length > 0 && widths.every((w) => w === STYLE_DIM_COUNT), `found widths ${JSON.stringify(widths)}`);
  }

  console.log("StyleSpec schema");
  t.check("the neutral spec is valid", StyleSpecSchema.safeParse(spec).success);
  t.check("a spec round-trips through JSON", StyleSpecSchema.safeParse(JSON.parse(JSON.stringify(spec))).success);
  // Mutates a deep copy and reports whether it still validates. Typed against
  // StyleSpec; `as never` marks the places a test deliberately writes a value
  // the type would refuse.
  const bad = (mutate: (s: StyleSpec) => void) => {
    const copy = JSON.parse(JSON.stringify(spec)) as StyleSpec;
    mutate(copy);
    return StyleSpecSchema.safeParse(copy).success;
  };
  t.check("rejects quantiles out of order", !bad((s) => (s.pacing.cutLenSec.byClipKind.talking = { p10: 5, p50: 2, p90: 1 })));
  t.check("rejects totalSec with min > p50", !bad((s) => (s.pacing.totalSec = { p50: 10, min: 20, max: 30 })));
  t.check("rejects a non-hex caption color", !bad((s) => (s.captions.colors.text = "white")));
  t.check("rejects wordsPerGroup of 0", !bad((s) => (s.captions.wordsPerGroup = 0)));
  t.check("rejects an unknown caption mode", !bad((s) => (s.captions.mode = "blink" as never)));
  t.check("rejects a rate above 1", !bad((s) => (s.camera.punchInRate = 1.5)));
  t.check("rejects zoomScale below 1", !bad((s) => (s.camera.zoomScale = 0.9)));
  t.check("rejects a wrong-width embedding", !bad((s) => (s.embedding = [0.1, 0.2])));
  t.check("rejects an unknown source kind", !bad((s) => (s.source.kind = "vibes" as never)));
  t.check("rejects an unknown version", !bad((s) => (s.version = 2 as never)));
  t.check("accepts a clip kind that is simply absent", (() => {
    const copy = JSON.parse(JSON.stringify(spec)) as StyleSpec;
    delete copy.pacing.cutLenSec.byClipKind.static;
    return StyleSpecSchema.safeParse(copy).success;
  })());
  t.check("fills the grade defaults", spec.grade.saturation === 1 && spec.grade.contrast === 1 && spec.grade.temperatureShift === 0);

  console.log("embedding");
  const emb = deriveEmbedding(spec);
  t.check("has the full width", emb.length === STYLE_DIM_COUNT);
  t.check("every value is finite and within 0-1", emb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  t.check("is deterministic", JSON.stringify(deriveEmbedding(spec)) === JSON.stringify(emb));
  t.check("withEmbedding attaches it and the result still validates", (() => {
    const w = withEmbedding(spec);
    return w.embedding!.length === STYLE_DIM_COUNT && StyleSpecSchema.safeParse(w).success;
  })());
  t.check("changing a field moves the embedding", JSON.stringify(deriveEmbedding({ ...spec, pacing: { ...spec.pacing, cutsPerMin: 45 } })) !== JSON.stringify(emb));

  console.log("projections and the known mask");
  const fv = vectorFromFeatures(features());
  const sv = vectorFromSpec(spec);
  const idx = (key: string) => STYLE_DIMS.findIndex((d) => d.key === key);
  t.check("a video has no grade adjustment: those dims are unknown", ["gradeSaturation", "gradeContrast", "gradeBrightness", "gradeWarmth"].every((k) => !fv.known[idx(k)]));
  t.check("a spec has no measurable shake or speech: those dims are unknown", !sv.known[idx("shake")] && !sv.known[idx("speechRatio")] && !sv.known[idx("loudnessDb")]);
  t.check("both know the pacing dims", ["cutsPerMin", "cutLenP50", "hookSec", "durationSec"].every((k) => fv.known[idx(k)] && sv.known[idx(k)]));
  t.check("a null feature stays unknown, not zero", (() => {
    const v = vectorFromFeatures(features({ captionCoverage: null, sfxPerMin: null, zoomScale: null }));
    return !v.known[idx("captionCoverage")] && !v.known[idx("sfxPerMin")] && !v.known[idx("zoomScale")];
  })());
  t.check("a 'none' caption spec has no captionWords", !vectorFromSpec({ ...spec, captions: { ...spec.captions, mode: "none" } }).known[idx("captionWords")]);
  t.check("unknown dims are filled with the prior in the stored embedding", (() => {
    const e = deriveEmbedding(spec);
    const shakeDim = STYLE_DIMS[idx("shake")];
    return near(e[idx("shake")], normalizeDim(shakeDim, shakeDim.prior)!, 1e-3);
  })());

  console.log("distance");
  t.check("a spec is at distance 0 from itself", styleDistance(sv, sv).score === 0);
  const fast = { ...spec, pacing: { ...spec.pacing, cutsPerMin: 50, hookSec: 0.6 } };
  const slow = { ...spec, pacing: { ...spec.pacing, cutsPerMin: 4, hookSec: 6 } };
  const dFast = styleDistance(vectorFromSpec(fast), sv).score!;
  const dSlow = styleDistance(vectorFromSpec(slow), sv).score!;
  t.check("a different spec is farther than an identical one", dFast > 0 && dSlow > 0);
  const veryFast = { ...fast, pacing: { ...fast.pacing, cutsPerMin: 60, hookSec: 0.3 } };
  t.check("distance grows as a spec moves further away", styleDistance(vectorFromSpec(veryFast), sv).score! > dFast);
  t.check("distance is symmetric", near(styleDistance(sv, vectorFromSpec(fast)).score!, dFast, 1e-12));
  const cmp = styleDistance(fv, sv);
  t.check("video-vs-spec compares only dims both know", cmp.compared === Object.keys(cmp.perDim).length && cmp.compared < STYLE_DIM_COUNT && cmp.compared > 5, `compared=${cmp.compared}`);
  t.check("video-vs-spec never scores an unknown dim", !("shake" in cmp.perDim) && !("gradeSaturation" in cmp.perDim));
  t.check("a video that matches its spec on the shared dims is close", (() => {
    const matching = features({ cutsPerMin: spec.pacing.cutsPerMin, hookSec: spec.pacing.hookSec, durationSec: spec.pacing.totalSec.p50, cutLenP10: 0.9, cutLenP50: 2.6, cutLenP90: 5.6 });
    return styleDistance(vectorFromFeatures(matching), sv).score! < 0.2;
  })());
  t.check("a video far from its spec is farther", (() => {
    const off = features({ cutsPerMin: 55, hookSec: 0.4, durationSec: 150, cutLenP50: 0.4 });
    return styleDistance(vectorFromFeatures(off), sv).score! > styleDistance(fv, sv).score!;
  })());
  t.check("perDim names the dimension that differs", styleDistance(vectorFromSpec(fast), sv).perDim.cutsPerMin! > styleDistance(vectorFromSpec(fast), sv).perDim.punchInRate!);
  t.check("no shared dims → null score, not 0", styleDistance({ values: sv.values, known: sv.known.map(() => false) }, sv).score === null);

  t.finish("style");
};

main();

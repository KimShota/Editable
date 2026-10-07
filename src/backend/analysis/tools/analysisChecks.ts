import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_FILE } from "../../pipeline/whisper";
import { makeChecker, near } from "../../tools/checks";
import { decodePcm, dropNonSpeechTags, measureAudio, trackBeat } from "../audio";
import { analyzeVideoFile } from "../analyzer";
import { classifyCaptions } from "../captions";
import { computeStyleFeatures } from "../features";
import { probeMedia } from "../probe";
import { StyleFeaturesSchema, VideoAnalysisSchema } from "../schemas";
import { ANALYZER_VERSION } from "../version";
import { SETUP_HINT, vocalsInstalled } from "../vocals";
import { makeBeatVideo, makeHardCutVideo, makePunchInVideo, makeShakeVideo, makeSubjectVideo } from "./fixtures";

/**
 * Analyzer checks against synthetic videos whose ground truth we built
 * (fixtures.ts): hard cuts at known times, a same-take punch-in at a known
 * time and scale, a click track at a known tempo, a shaking camera, a moving
 * subject. Needs ffmpeg; needs neither whisper, tesseract nor an API key
 * (the one whisper-dependent check is skipped when the model is absent).
 *
 *   npm run test:analysis
 */

const opts = { transcript: false, captions: false } as const;

const main = async () => {
  const t = makeChecker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-analysis-checks-"));
  const f = (name: string) => path.join(dir, name);

  try {
    console.log("hard cuts (4 unrelated 2 s pictures)");
    const hard = makeHardCutVideo(f("hard.mp4"));
    const h = await analyzeVideoFile(f("hard.mp4"), opts);
    t.check("finds exactly the 3 constructed cuts", h.analysis.cuts.length === 3, `got ${h.analysis.cuts.map((c) => c.atSec.toFixed(2))}`);
    t.check("at 2, 4 and 6 s (±0.1)", hard.cutTimesSec.every((c, i) => near(h.analysis.cuts[i]?.atSec ?? -99, c, 0.1)));
    t.check("all are hard cuts", h.analysis.cuts.every((c) => c.kind === "hard"));
    t.check("4 shots that tile the whole video", h.analysis.shots.length === 4 && h.analysis.shots[0].startSec === 0 && near(h.analysis.shots[3].endSec, hard.durationSec, 0.05));
    t.check("cut length p50 is 2 s", near(h.analysis.cutLenSec.p50, 2, 0.1));
    t.check("no false punch-ins between unrelated pictures", h.analysis.punchIns.length === 0);
    t.check("cutsPerMin = 3 cuts in 8 s = 22.5", near(h.features.cutsPerMin, 22.5, 0.5));
    t.check("hook is the first shot's length", near(h.features.hookSec, 2, 0.1));
    t.check("no audio track is reported, not guessed", !h.analysis.media.hasAudio && !h.analysis.audio.present);
    t.check("audio-derived features are null (unknown), not 0", h.features.sfxPerMin === null && h.features.beatStrength === null && h.features.loudnessMeanDb === null);
    t.check("the missing track is explained in warnings", h.analysis.warnings.some((w) => /no audio track/.test(w)));
    t.check("reports the displayed size and fps", h.analysis.media.width === 360 && h.analysis.media.height === 640 && near(h.analysis.media.fps, 30, 0.5));

    console.log("punch-in (one continuous take, 1.3x from 2.5 s to 5 s)");
    const punch = makePunchInVideo(f("punch.mp4"));
    const p = await analyzeVideoFile(f("punch.mp4"), opts);
    t.check("scene detection alone would see nothing, but 2 jump cuts are found", p.analysis.cuts.length === 2 && p.analysis.cuts.every((c) => c.kind === "jump"), `got ${JSON.stringify(p.analysis.cuts)}`);
    t.check("the punch-in lands at 2.5 s (within a sampled frame)", near(p.analysis.punchIns[0]?.atSec ?? -99, punch.punchInAtSec, 0.15));
    t.check("it is a punch IN of about 1.3x", p.analysis.punchIns[0]?.direction === "in" && near(p.analysis.punchIns[0].scale, punch.scale, 0.1));
    t.check("the return at 5 s is a punch OUT of about 1/1.3", p.analysis.punchIns[1]?.direction === "out" && near(p.analysis.punchIns[1].atSec, punch.punchOutAtSec, 0.15) && near(p.analysis.punchIns[1].scale, 1 / punch.scale, 0.1));
    t.check("punchInRate counts only the punch-in: 1 of 2 cuts", near(p.features.punchInRate, 0.5, 1e-9));
    t.check("zoomScale is the median punch-in", near(p.features.zoomScale ?? 0, punch.scale, 0.1));

    console.log("camera shake vs subject motion");
    makeShakeVideo(f("shake.mp4"));
    makeSubjectVideo(f("subject.mp4"));
    const sh = await analyzeVideoFile(f("shake.mp4"), opts);
    const su = await analyzeVideoFile(f("subject.mp4"), opts);
    t.check("a shaking camera reads as shake, not subject motion", sh.analysis.motion.shakeMean > 4 * sh.analysis.motion.subjectMean, `shake=${sh.analysis.motion.shakeMean.toFixed(1)} subject=${sh.analysis.motion.subjectMean.toFixed(1)}`);
    t.check("a moving subject in a locked-off frame reads as subject, not shake", su.analysis.motion.subjectMean > 4 * su.analysis.motion.shakeMean, `shake=${su.analysis.motion.shakeMean.toFixed(1)} subject=${su.analysis.motion.subjectMean.toFixed(1)}`);
    t.check("shake is NOT mistaken for cuts (regression: 60 false cuts)", sh.analysis.cuts.length === 0, `got ${sh.analysis.cuts.length}`);
    t.check("a locked-off moving subject has no cuts", su.analysis.cuts.length === 0);
    t.check("energy and shake features are 0-1", [sh, su].every((r) => r.features.energy >= 0 && r.features.energy <= 1 && r.features.shake >= 0 && r.features.shake <= 1));
    t.check("the shaky clip has higher shake than the still one", sh.features.shake > su.features.shake);
    t.check("motion curves are sampled at the analysis rate", sh.analysis.motion.hz >= 4 && near(sh.analysis.motion.subject.length, sh.analysis.motion.hz * 6, sh.analysis.motion.hz));

    console.log("audio (120 BPM click track)");
    const beat = makeBeatVideo(f("beat.mp4"), 120, 12);
    const b = await analyzeVideoFile(f("beat.mp4"), opts);
    t.check("finds the tempo within 2 BPM", near(b.analysis.audio.beat.bpm ?? 0, beat.bpm, 2), `bpm=${b.analysis.audio.beat.bpm}`);
    t.check("with high confidence", b.analysis.audio.beat.confidence > 0.5);
    t.check("beat grid spacing matches the tempo", (() => {
      const bt = b.analysis.audio.beat.beatTimesSec;
      return bt.length > 10 && near(bt[5] - bt[4], 60 / beat.bpm, 0.03);
    })());
    t.check("the beat grid lands on the clicks (within 60 ms)", (() => {
      const bt = b.analysis.audio.beat.beatTimesSec;
      return bt.slice(1, 10).every((x) => near(x / 0.5, Math.round(x / 0.5), 0.12));
    })());
    t.check("loudness curve is 10 Hz over the whole video", near(b.analysis.audio.loudnessDb.length, 120, 2));
    t.check("without a transcript, speech ratio and SFX onsets are unknown, not 0", b.analysis.audio.speechRatio === null && b.analysis.audio.musicRatio === null && b.analysis.audio.sfxOnsetsSec.length === 0 && b.features.sfxPerMin === null);
    t.check("beatStrength feature carries the confidence", near(b.features.beatStrength ?? -1, b.analysis.audio.beat.confidence, 1e-9));

    // With speech KNOWN to be absent, every click is a non-speech onset.
    const pcm = decodePcm(f("beat.mp4"));
    const known = measureAudio(pcm, 12, []);
    t.check("speech known-absent: speechRatio is 0", known.speechRatio === 0);
    t.check("…and the ~24 clicks are found as SFX onsets", near(known.sfxOnsetsSec.length, 24, 3), `got ${known.sfxOnsetsSec.length}`);
    t.check("…and about a fifth of the windows carry the audible bed", near(known.musicRatio ?? -1, 0.2, 0.06), `got ${known.musicRatio}`);
    const talking = measureAudio(pcm, 12, [[0, 12]]);
    t.check("speech covering everything: ratio 1, no SFX, no bed", talking.speechRatio === 1 && talking.sfxOnsetsSec.length === 0 && talking.musicRatio === 0);

    console.log("beat tracker edge cases");
    t.check("silence has no tempo", trackBeat(new Array(1000).fill(0), 16).bpm === null);
    t.check("too short to call a tempo", trackBeat(new Array(100).fill(30), 1.6).bpm === null);
    // Sparse onsets with pseudo-random gaps (seeded, so deterministic). A
    // fixed-modulus pattern would itself be periodic and be rightly detected.
    const randomOnsets = (seed: number): number[] => {
      let s = (seed * 2654435761) >>> 0;
      const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      const env = new Array<number>(1000).fill(0);
      for (let i = 5; i < 1000; i += 5 + Math.floor(rnd() * 40)) env[i] = 20;
      return env;
    };
    t.check("aperiodic onsets never produce a beat (8 seeds)", [1, 2, 3, 4, 5, 6, 7, 8].every((seed) => trackBeat(randomOnsets(seed), 16).bpm === null));
    t.check("a strictly periodic onset train IS detected (period 26 frames ≈ 144 BPM)", (() => {
      const env = new Array<number>(1000).fill(0);
      for (let i = 0; i < 1000; i += 26) env[i] = 20;
      return near(trackBeat(env, 16).bpm ?? 0, 144.2, 1.5);
    })());

    console.log("whisper non-speech tags");
    const w = (...texts: string[]) => texts.map((text, i) => ({ text, startSec: i, endSec: i + 1 }));
    const texts = (ws: { text: string }[]) => ws.map((x) => x.text).join(" ");
    t.check("drops a single-token tag", texts(dropNonSpeechTags(w("hello", "[Music]", "world"))) === "hello world");
    t.check("drops a multi-token tag", texts(dropNonSpeechTags(w("a", "[Beep,", "beep,", "beep]", "b"))) === "a b");
    t.check("drops a long repeated tag (12 s of beeps)", dropNonSpeechTags(w("[Beep,", ...Array(9).fill("beep,"), "beep]")).length === 0);
    t.check("drops parenthesized sounds with trailing punctuation", texts(dropNonSpeechTags(w("hi", "(applause).", "thanks"))) === "hi thanks");
    t.check("drops music-note tokens", texts(dropNonSpeechTags(w("♪", "la", "♪"))) === "la");
    t.check("keeps ordinary speech untouched", texts(dropNonSpeechTags(w("just", "talking", "here."))) === "just talking here.");
    t.check("an unclosed opener does not swallow the rest of the speech", (() => {
      const long = w("[oops", ...Array(70).fill("word"));
      return dropNonSpeechTags(long).length === 71;
    })());
    t.check("empty in, empty out", dropNonSpeechTags([]).length === 0);

    console.log("caption classification (OCR results → mode)");
    const words = (n: number, y = 0.85) => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, centerY: y }));
    t.check("no text anywhere → none", classifyCaptions(Array(10).fill([])).mode === "none");
    t.check("text in 1 of 12 frames is below the floor → none", classifyCaptions([words(3), ...Array(11).fill([])]).mode === "none");
    t.check("a few words, almost always on → karaoke", classifyCaptions(Array(10).fill(words(3))).mode === "karaoke");
    t.check("full sentences, almost always on → full", classifyCaptions(Array(10).fill(words(9))).mode === "full");
    t.check("text now and then → keyword", classifyCaptions([...Array(4).fill(words(3)), ...Array(6).fill([])]).mode === "keyword");
    t.check("position comes from where the words sit", classifyCaptions(Array(10).fill(words(3, 0.1))).position === "top" && classifyCaptions(Array(10).fill(words(3, 0.5))).position === "middle" && classifyCaptions(Array(10).fill(words(3, 0.9))).position === "bottom");
    t.check("a lone stray word is not a caption", classifyCaptions(Array(10).fill(words(1))).mode === "none");

    console.log("probe and guards");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f("beat.mp4"), "-vn", "-c:a", "aac", f("audio-only.m4a")]);
    t.throws("an audio-only file has no picture to analyze", () => probeMedia(f("audio-only.m4a")), /no video stream/);
    fs.writeFileSync(f("garbage.mp4"), "not a video");
    t.throws("garbage is refused, not half-analyzed", () => probeMedia(f("garbage.mp4")));
    await t.rejects("a missing file is refused", () => analyzeVideoFile(f("nope.mp4"), opts), /no such file/);
    await t.rejects("over the duration cap is refused before decoding", () => analyzeVideoFile(f("hard.mp4"), { ...opts, maxDurationSec: 3 }), /over the 3s limit/);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-display_rotation", "90", "-i", f("hard.mp4"), "-c", "copy", f("rotated.mp4")]);
    const rot = probeMedia(f("rotated.mp4"));
    t.check("a rotation flag swaps to the displayed size", rot.width === 640 && rot.height === 360, `got ${rot.width}x${rot.height}`);

    console.log("the stored contract");
    t.check("the analysis carries the analyzer version", h.analysis.analyzerVersion === ANALYZER_VERSION);
    t.check("the content hash passes through when supplied", (await analyzeVideoFile(f("hard.mp4"), { ...opts, contentHash: "abc" })).analysis.contentHash === "abc");
    t.check("an analysis survives a JSON round trip (as stored in jsonb)", VideoAnalysisSchema.safeParse(JSON.parse(JSON.stringify(b.analysis))).success);
    t.check("features validate and survive JSON", StyleFeaturesSchema.safeParse(JSON.parse(JSON.stringify(b.features))).success);
    t.check("features are a pure function of the analysis", JSON.stringify(computeStyleFeatures(b.analysis)) === JSON.stringify(b.features));
    t.check("every feature is finite or null", Object.values(p.features).every((v) => v === null || Number.isFinite(v)));
    t.check("re-analyzing is deterministic", JSON.stringify((await analyzeVideoFile(f("punch.mp4"), opts)).features) === JSON.stringify(p.features));

    console.log("whisper (skipped when the model isn't installed)");
    if (fs.existsSync(MODEL_FILE)) {
      const withSpeech = await analyzeVideoFile(f("beat.mp4"), { transcript: true, captions: false });
      t.check("a click track is not reported as speech (whisper says '[Beep…]')", (withSpeech.analysis.audio.speechRatio ?? 1) < 0.15, `speechRatio=${withSpeech.analysis.audio.speechRatio}`);
      t.check("…so its clicks are found as SFX onsets", (withSpeech.analysis.audio.sfxOnsetsSec.length ?? 0) > 15, `sfx=${withSpeech.analysis.audio.sfxOnsetsSec.length}`);
      console.log("vocal separation (skipped when Demucs isn't installed)");
      if (vocalsInstalled()) {
        const separated = await analyzeVideoFile(f("beat.mp4"), { transcript: true, captions: false, vocals: true });
        t.check("the transcript is taken from the vocals with the music removed", separated.analysis.transcript?.vocalsSeparated === true && !separated.analysis.warnings.some((w) => /vocal separation/.test(w)), JSON.stringify(separated.analysis.warnings));
        t.check("a track with no voice has no words once the music is out", (separated.analysis.transcript?.words.length ?? 1) === 0, JSON.stringify(separated.analysis.transcript?.words.slice(0, 5)));
      } else {
        console.log(`  – skipped (${SETUP_HINT})`);
      }
      const full = await analyzeVideoFile(f("beat.mp4"), { transcript: true, captions: false, vocals: false });
      t.check("with separation off, the full mix is transcribed and says so", full.analysis.transcript?.vocalsSeparated === false && !full.analysis.warnings.some((w) => /vocal separation/.test(w)));
    } else {
      console.log("  – skipped (no models/ggml-medium.bin)");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  t.finish("analysis");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { VideoAnalysis } from "../analysis/schemas";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";
import { fallbackOptions } from "./models";
import { type Decomposition, DecompositionSchema, type RecreationSpec } from "./schemas";

/**
 * Source video → RecreationSpec. The analyzer has already measured the shot
 * boundaries and the word timings; Claude looks at keyframes of every shot
 * plus the numbered transcript and says what each shot IS (kind, framing,
 * subject, on-screen text), how the video is built (beats), and where the
 * spoken lines break, by word index. `assembleSpec` then turns word indices
 * back into measured times, so no timestamp in the spec comes from the model.
 */

// Sonnet for now, to cut cost (Opus 5.5 is 2x the price): set RECREATION_MODEL=claude-opus-5-5 to go back.
const DEFAULT_MODEL = "claude-sonnet-5-5";

/** A stable source id from the platform's own video id, else a hash of the URL. */
export const sourceIdFromUrl = (url: string): string => {
  const m = url.match(/instagram\.com\/(?:reel|reels|p)\/([\w-]+)/) ?? url.match(/tiktok\.com\/.*\/video\/(\d+)/) ?? url.match(/youtube\.com\/shorts\/([\w-]+)/);
  return m ? m[1] : createHash("sha256").update(url).digest("hex").slice(0, 12);
};

export type Keyframe = { shotIndex: number; atSec: number; path: string; key: string };

/** 1 frame for a short shot, up to 3 for a long one, evenly inside the shot. */
export const keyframeTimes = (startSec: number, endSec: number): number[] => {
  const dur = endSec - startSec;
  const n = dur < 3 ? 1 : dur < 8 ? 2 : 3;
  return Array.from({ length: n }, (_, k) => Number((startSec + ((k + 0.5) / n) * dur).toFixed(2)));
};

const fmt = (s: number) => s.toFixed(2);

export const buildDecompositionText = (analysis: VideoAnalysis): string => {
  const words = analysis.transcript?.words ?? [];
  const shots = analysis.shots.map((s, i) => `  shot ${i}: ${fmt(s.startSec)}–${fmt(s.endSec)}s`).join("\n");
  const numbered = words.map((w, i) => `[${i}] ${w.text}`).join(" ");
  const c = analysis.captions;
  return [
    `MEASURED: ${fmt(analysis.media.durationSec)}s, ${analysis.media.width}x${analysis.media.height}.`,
    `Shots (measured cuts; do not change them):\n${shots}`,
    `On-screen text coverage ${c.coverage ?? "?"}, median ${c.medianWords ?? "?"} words, position ${c.position ?? "?"}.`,
    `Speech ratio ${analysis.audio.speechRatio ?? "?"}, music ratio ${analysis.audio.musicRatio ?? "?"}.`,
    `\nNUMBERED TRANSCRIPT (${words.length} words):\n${numbered || "(no speech)"}`,
    `\nDecompose this video so it can be recreated shot by shot with a different presenter and product. ` +
      `Give exactly one shots[] entry per measured shot (shotIndex 0-${analysis.shots.length - 1}). ` +
      `Split the transcript into spoken lines by word index, covering every word in order. ` +
      `The transcript was taken from the vocal track with the music removed, so the words of a SONG are in it too. ` +
      `Say how each line is delivered: on_camera (a visible person says it, or lip-syncs it), voiceover (someone off screen over other footage), ` +
      `or lyrics (sung words of a song playing under the video that nobody in it says). Judge from the words (sung lyrics rhyme, repeat and do not address the viewer), ` +
      `the frames (is a mouth visibly speaking?) and the speech and music ratios. When nobody in the video is speaking, mark every line lyrics.`,
  ].join("\n");
};

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
type TextBlock = { type: "text"; text: string };

export const decompose = async (
  analysis: VideoAnalysis,
  keyframes: Keyframe[],
  opts: { model?: string; client?: Anthropic; costSink?: CostSink; ref?: string } = {},
): Promise<{ decomposition: Decomposition; model: string }> => {
  const model = opts.model ?? process.env.RECREATION_MODEL ?? DEFAULT_MODEL;
  const client = opts.client ?? new Anthropic({ timeout: 300_000 });

  const content: (ImageBlock | TextBlock)[] = [{ type: "text", text: "Keyframes of a viral short-form video, in order. Each is labelled with its shot and time." }];
  for (const k of keyframes) {
    content.push({ type: "text", text: `shot ${k.shotIndex}, frame at ${fmt(k.atSec)}s:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(k.path).toString("base64") } });
  }
  content.push({ type: "text", text: buildDecompositionText(analysis) });

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16_000,
    ...fallbackOptions(model),
    output_config: { effort: "medium", format: betaZodOutputFormat(DecompositionSchema) },
    system:
      "You decompose viral short-form videos for faithful shot-by-shot recreation. Describe only what is visible in the frames or present in the transcript. Never invent times: shots and word indices are given.",
    messages: [{ role: "user", content }],
  });
  await opts.costSink?.(anthropicCostEntry(response.model, response.usage, "recreation_decompose", { ref: opts.ref }));
  if (response.stop_reason === "refusal") throw new Error("recreation: the model declined to decompose this video");
  if (response.stop_reason === "max_tokens") throw new Error("recreation: decomposition was cut off at max_tokens");
  if (!response.parsed_output) throw new Error("recreation: response did not match the decomposition schema");
  return { decomposition: response.parsed_output, model: response.model };
};

export type SourceMeta = { sourceId: string; url: string | null; creator: string | null; likes: number | null; comments: number | null; views: number | null };

/**
 * Merges measurements and labels into a RecreationSpec. Lenient where the
 * model's output can be repaired without guessing (line boundaries are
 * rebuilt from the starts it chose, so lines always tile the transcript),
 * strict where it can't (every measured shot must be labelled exactly once).
 */
export const assembleSpec = (analysis: VideoAnalysis, d: Decomposition, keyframes: Keyframe[], meta: SourceMeta, model: string): RecreationSpec => {
  const n = analysis.shots.length;
  const labels = new Map(d.shots.map((s) => [s.shotIndex, s]));
  const missing = analysis.shots.map((_, i) => i).filter((i) => !labels.has(i));
  if (missing.length > 0 || d.shots.length !== n) {
    throw new Error(`recreation: expected one label per shot (0-${n - 1}); missing ${missing.join(", ") || "none"}, got ${d.shots.length}`);
  }
  const shotId = (i: number) => `s${i}`;

  const shots = analysis.shots.map((s, i) => {
    const { shotIndex: _drop, ...label } = labels.get(i)!;
    void _drop;
    return {
      ...label,
      id: shotId(i),
      startSec: s.startSec,
      endSec: s.endSec,
      keyframes: keyframes.filter((k) => k.shotIndex === i).map((k) => ({ atSec: k.atSec, key: k.key })),
    };
  });

  const words = analysis.transcript?.words ?? [];
  const starts = [
    ...new Map(d.speechLines.filter((l) => l.fromWord >= 0 && l.fromWord < words.length).map((l) => [l.fromWord, { role: l.role, delivery: l.delivery }])).entries(),
  ].sort((a, b) => a[0] - b[0]);
  if (words.length > 0 && (starts.length === 0 || starts[0][0] !== 0)) starts.unshift([0, starts[0]?.[1] ?? { role: "hook" as const, delivery: "on_camera" as const }]);
  const all = starts.map(([from, { role, delivery }], i) => {
    const to = (starts[i + 1]?.[0] ?? words.length) - 1;
    const ws = words.slice(from, to + 1);
    const startSec = ws[0].startSec;
    const endSec = ws[ws.length - 1].endSec;
    return {
      text: ws.map((w) => w.text).join(" "),
      startSec,
      endSec,
      role,
      delivery,
      shotIds: shots.filter((s) => s.startSec < endSec && s.endSec > startSec).map((s) => s.id),
      wordCount: ws.length,
    };
  });
  // Sung words are not lines of the script: nobody says them, so there is nothing to adapt or voice.
  const lines = all.flatMap((l) => (l.delivery === "lyrics" ? [] : [{ ...l, delivery: l.delivery }]));
  const lyrics = all.filter((l) => l.delivery === "lyrics").map((l) => ({ text: l.text, startSec: l.startSec, endSec: l.endSec }));

  return {
    sourceId: meta.sourceId,
    sourceUrl: meta.url,
    creator: meta.creator,
    engagement: { likes: meta.likes, comments: meta.comments, views: meta.views },
    media: { durationSec: analysis.media.durationSec, width: analysis.media.width, height: analysis.media.height, fps: analysis.media.fps },
    language: d.language,
    topic: d.topic,
    whyItWorks: d.whyItWorks,
    hook: d.hook,
    soundDependent: d.soundDependent,
    structure: d.structure.map((b) => ({ ...b, shotIndices: b.shotIndices.filter((i) => i >= 0 && i < n) })),
    shots,
    speech: { lines, lyrics, wordsPerMin: analysis.transcript?.wordsPerMin ?? null },
    captionStyle: d.captionStyle,
    audioBed: {
      musicRatio: analysis.audio.musicRatio,
      speechRatio: analysis.audio.speechRatio,
      bpm: analysis.audio.beat.bpm,
      beatTimesSec: analysis.audio.beat.beatTimesSec,
    },
    createdAt: new Date().toISOString(),
    model,
  };
};

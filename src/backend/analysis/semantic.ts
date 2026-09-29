import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { withTimeout } from "../pipeline/generation/withTimeout";
import { extractFrame } from "../pipeline/shotDetect";
import { type Semantic, SemanticSchema } from "./schemas";

/**
 * The semantic half of the analyzer: what the video is ABOUT and how it
 * opens — the only things that need a model's judgment. Following the
 * layering rule (measure first, ML second, LLM only about meaning), it is
 * never asked for a timestamp, a count, or a duration; those are all
 * measured elsewhere.
 *
 * A provider interface, like generation/provider.ts, so tests and later
 * phases can swap the implementation, and so the analyzer runs fine — with
 * `semantic: null` — where no API key is configured.
 */

export interface SemanticProvider {
  describe(input: { filePath: string; durationSec: number; transcriptExcerpt: string | null }): Promise<Semantic>;
}

/** The cheapest vision-capable model: this is tagging, not creative work. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const FRAMES = 6;
const FRAME_WIDTH = 384;
/** Enough transcript to tell the topic and the hook, not the whole video. */
const TRANSCRIPT_EXCERPT_CHARS = 1200;
const TIMEOUT_MS = 60_000;

const PROMPT =
  "These frames are evenly spaced through one short-form vertical video" +
  " (in order). Describe it for a creator-style database. `topic`: what it is about, under 12 words." +
  " `hookType`: how it opens. `formatType`: what kind of video it is." +
  " `tone`: up to 4 adjectives. `language`: the spoken or written language, or \"none\"." +
  " `overlayKinds`: kinds of on-screen graphics you can SEE (e.g. \"caption\", \"sticker\", \"lower-third\", \"progress bar\"), or an empty list." +
  " Judge only what is visible or in the transcript; do not guess numbers or timings.";

export class ClaudeSemanticProvider implements SemanticProvider {
  private client: Anthropic | null = null;

  constructor(private readonly model = process.env.ANALYSIS_SEMANTIC_MODEL || DEFAULT_MODEL) {}

  private getClient(): Anthropic {
    if (this.client) return this.client;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("semantic: ANTHROPIC_API_KEY is required (put it in .env)");
    // Same reasoning as faceCheck.ts: the SDK's default timeout is 10 minutes.
    this.client = new Anthropic({ timeout: TIMEOUT_MS });
    return this.client;
  }

  async describe({ filePath, durationSec, transcriptExcerpt }: Parameters<SemanticProvider["describe"]>[0]): Promise<Semantic> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-semantic-"));
    try {
      const images: Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
      for (let i = 0; i < FRAMES; i++) {
        const out = path.join(workDir, `f${i}.jpg`);
        if (!extractFrame(filePath, ((i + 0.5) / FRAMES) * durationSec, out, FRAME_WIDTH)) continue;
        images.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(out).toString("base64") } });
      }
      if (images.length === 0) throw new Error("semantic: could not extract any frames");

      const transcript = transcriptExcerpt ? `\n\nTranscript excerpt:\n${transcriptExcerpt.slice(0, TRANSCRIPT_EXCERPT_CHARS)}` : "";
      const response = await withTimeout(
        this.getClient().messages.parse({
          model: this.model,
          max_tokens: 512,
          messages: [{ role: "user", content: [...images, { type: "text" as const, text: PROMPT + transcript }] }],
          output_config: { format: zodOutputFormat(SemanticSchema) },
        }),
        TIMEOUT_MS + 15_000,
        "semantic (Anthropic vision)",
      );
      if (!response.parsed_output) throw new Error("semantic: response did not match schema");
      return response.parsed_output;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

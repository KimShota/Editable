import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authoringDir } from "../pipeline/paths";
import { DraftSchema } from "./schemas";
import { Analysis, Draft, Shot } from "./types";

/**
 * Module A3 — Synthesize.
 * Reverse-engineers one analyzed reference clip into a draft Format: the
 * hard, judgment-heavy step the rest of authoring exists to feed. Needs
 * the Anthropic API specifically (not the claude-cli fallback the render
 * pipeline's resolvers use) because it's multimodal — sampled frames are
 * the only way to see on-screen text/overlays/memes the transcript can't.
 *
 * FormatSchema's cross-reference rules (an event's `roleId` must name a
 * real anchor in the same block; a semantic anchor's window must reference
 * a LITERAL anchor) live in a `.superRefine`, which cannot be expressed as
 * a JSON schema constraint for structured outputs — nothing can guarantee
 * a model invents self-consistent ids on the first try. So this is a
 * plain-JSON prompt (mirroring resolvers/claudeCli.ts's extractJson
 * approach) validated with FormatSchema.safeParse after the fact, with the
 * validation errors fed back for the model to repair — generate, validate,
 * repair, same idea as resolveRoles' confidence-threshold fallback, just
 * applied to a whole document instead of one anchor.
 */

const DEFAULT_MODEL = "claude-opus-4-8";
/** Bounds the multimodal call's cost/context against a long or fast-cut
 *  source — analyze() already caps at 40 shots; this caps further. */
const MAX_FRAMES = 20;
const MAX_REPAIR_ROUNDS = 2;
const MAX_TOKENS = 8000;

/** Downsample evenly (not truncate) so late-video shots aren't dropped. */
const selectFramesForSynthesis = (shots: Shot[]): Shot[] => {
  if (shots.length <= MAX_FRAMES) return shots;
  const stride = shots.length / MAX_FRAMES;
  return Array.from({ length: MAX_FRAMES }, (_, i) => shots[Math.floor(i * stride)]);
};

/**
 * The FormatSchema contract, in prose — the model never sees the zod
 * source, so every field, every union variant, and the closed lists of
 * real renderer components/transitions it may reference are spelled out
 * here. Keeping this accurate to src/backend/pipeline/schemas.ts and
 * src/backend/remotion/EdlVideo.tsx is what keeps drafts renderable.
 */
const FORMAT_CONTRACT = `Produce a JSON object of the shape {"rationale": string, "format": FORMAT}.

"rationale" is 2-4 sentences in plain English: what structural pattern you found (the beats, the pacing, why it likely works) — for a human reviewer, not consumed by any code.

FORMAT is a reusable, fill-in-the-blank template for THIS pipeline (not a description of the specific video — abstract the topic into a niche/placeholder the way "5 Secret [Tool] Codes" abstracts "Claude" into "[Tool]"):

{
  "id": string,               // kebab-case slug, unique-sounding
  "name": string,              // e.g. "5 Secret [Tool] Codes" — bracket the part that varies by niche
  "niche": string,              // who/what this format suits, e.g. "any tool with power-user tricks"
  "description": string,        // 1-3 sentences: the structural pattern, for format pickers
  "fps": 30,
  "width": <source width>, "height": <source height>,   // match the analyzed video exactly
  "captionStyle": { "component": "Captions", "params": { "position": "lowerThird" } },  // omit only if the source has no burned-in captions
  "sharedSlots": [ { "name": string, "mediaType": "audio", "required": false, "instructions": string } ],  // SFX reused across multiple blocks (e.g. a recurring "ding"); OMIT the whole array if there's nothing shared
  "blocks": [ BLOCK, ... ]
}

BLOCK (one per beat of the video — a hook, then each point/step/reveal, then a CTA — in the order they play):
{
  "id": string,          // kebab-case, unique within the format
  "title": string,       // human label, e.g. "Hook"
  "kind": "voice" | "broll",   // "voice" = the creator is talking and gets transcribed/anchored; "broll" = silent footage/screen-recording with no speech to anchor against
  "videoSlot": string,   // must equal the "name" of one of this block's own "slots" below (the main clip)
  "slots": [ SLOT, ... ], // every asset a user must film/supply for this block, INCLUDING the main clip
  "captions": boolean,    // true only for "voice" blocks where the source burns in word captions
  "anchors": [ ANCHOR, ... ],  // ONLY for "voice" blocks — omit/empty for "broll" (no transcript to anchor against)
  "events": [ EVENT, ... ],     // overlays/sfx that fire during this block
  "transitionAfter": { "component": "cut" | "fade" | "whooshZoom", "params": { "durationSec": number } }  // OMIT for a hard cut with no params object; include only if the source visibly transitions into the next block
}

SLOT (one thing the user must film/supply, with real filming direction — this is the founder-judgment part, be specific and concrete, not generic):
{ "name": string, "mediaType": "video" | "image" | "audio" | "text", "required": boolean, "instructions": string }
Every "voice" block's main clip slot must instruct the user to say a literal marker phrase matching that block's literal anchor phrasing (see ANCHOR below) — this is how the engine finds the block's own structure in EVERY user's differently-worded recording.

ANCHOR — two kinds, only inside "voice" blocks:
  LITERAL (near-certain, no LLM; marks block structure and captures the user's own variable words):
    { "id": string, "kind": "literal", "phrases": [string, ...],  // 1+ ways a user might actually phrase the fixed instruction line, e.g. ["Number one is", "First is"]
      "capture": boolean,        // true if the words right after the phrase are content to reuse (e.g. the user's own name for "code 1")
      "captureUntil": string,     // OPTIONAL: a fixed phrase that ends the capture
      "fallback": { "anchor": "blockStart" | "blockEnd", "offsetSec": number } }
  SEMANTIC (a free-form content moment, located by an LLM per real recording):
    { "id": string, "kind": "semantic", "description": string,   // plain-language description of the MEANING of the moment, e.g. "the pivot from problem to solution" — not keywords
      "form": string,   // OPTIONAL light constraint, e.g. "one sentence, starts with a verb"
      "window": { "afterAnchor": string, "beforeAnchor": string },  // OPTIONAL: bounds the search to between two LITERAL anchor ids IN THE SAME BLOCK (never a semantic anchor id)
      "fallback": { "anchor": "blockStart" | "blockEnd", "offsetSec": number }, "fallbackDurationSec": number }

EVENT (an overlay or sound effect that fires during a block; "id" must be unique across the WHOLE format):
{ "id": string, "kind": "overlay" | "sfx",
  "component": { "component": COMPONENT_NAME, "params": { ... } },
  "timing": TIMING,
  "durationSec": number,   // OPTIONAL — omit for an overlay that stays up until the block ends
  "until": TIMING          // OPTIONAL — alternative to durationSec: ends exactly when another anchor/role fires
}

COMPONENT_NAME — a CLOSED list; using anything else means the overlay silently never renders:
  overlays: "TextOverlay" (params: "textSlot" OR "textAnchor"+"textTemplate", "variant": "hook"|"resolve"|"title"|"description"|"cta", "fontSize"?),
            "ImageOverlay" (params: "imageSlot": <a slot name of mediaType "image">),
            "VideoOverlay" (params: "videoSlot": <a slot name of mediaType "video"> — a concurrent screen-recording/b-roll layered OVER the talking clip, muted),
            "StickerTitle" (params: "textAnchor"+"textTemplate" containing "{captured}", "fontSize"? — a rotated sticky-note title card),
            "SkillCard" (params: "textAnchor", "imageSlot"? — a named-thing card with a preview image below it)
  sfx: always "Sfx" (params: "audioSlot": <a slot name of mediaType "audio", usually from sharedSlots>, "volume": 0-1)

Slot indirection in "component.params" (assemble-time, not literal values you invent):
  "textSlot": <slot name of mediaType "text"> → renders that slot's literal text
  "textAnchor": <anchor id in this block> + optional "textTemplate" containing the substring "{captured}" → renders that anchor's captured words (from a "capture": true literal anchor), inserted into the template
  "imageSlot" / "audioSlot" / "videoSlot": <slot name of the matching mediaType> → renders that user-supplied file

TIMING — when an event fires, one of:
  { "kind": "role", "roleId": <anchor id, same block>, "edge": "start" | "end" | "captureStart", "offsetSec": number }
  { "kind": "fixed", "anchor": "blockStart" | "blockEnd", "offsetSec": number }
  { "kind": "sequence", "roleId": <anchor id>, "edge": "start"|"end"|"captureStart", "index": number, "count": number, "targetGapSec": number }  // use for N sibling events evenly spaced after one anchor (e.g. a flip-through of preview images) — every sibling repeats the same roleId/count/targetGapSec, only "index" differs (0-based)

Rules that WILL be checked and must hold:
- every block's "videoSlot" names one of that block's own "slots"
- every anchor "id" is unique within its block; every event "id" is unique across the whole format
- a semantic anchor's "window.afterAnchor"/"beforeAnchor" must each name a LITERAL anchor id in the SAME block (never itself, never a semantic anchor, never cross-block)
- every event's "timing.roleId" (and "until.roleId" if present) must name a real anchor id in that same block
- "broll" blocks have no "anchors" and no "captions": true
- only use the exact component names listed above, spelled exactly that way`;

const buildSynthesisPrompt = (analysis: Analysis, selectedShots: Shot[]): string => {
  const wordLines = analysis.words
    .map((w) => `${w.startSec.toFixed(2)}-${w.endSec.toFixed(2)} ${JSON.stringify(w.text)}`)
    .join("\n");
  const shotLines = analysis.shots
    .map((s) => `shot ${s.index}: ${s.startSec.toFixed(2)}s-${s.endSec.toFixed(2)}s`)
    .join("\n");
  const sampledNote =
    selectedShots.length < analysis.shots.length
      ? ` (a representative sample of ${selectedShots.length} is attached as images below, in order)`
      : " (attached as images below, in order)";

  return `You are reverse-engineering a short-form vertical video (${analysis.durationSec.toFixed(1)}s, ${analysis.width}x${analysis.height}) into a reusable FORMAT for "Editable", a video-templating engine. A format captures a proven structure — the beats, the timing, the overlay/sfx moments — as data, so a different creator can film their OWN content into the same slots and get a similarly-paced video out, without inventing the structure themselves.

${FORMAT_CONTRACT}

TRANSCRIPT — one word per line, start-end seconds relative to the clip:
${wordLines || "(no speech detected — this may be a silent/music-driven format; author it with mostly \"broll\" blocks)"}

SHOTS — ${analysis.shots.length} scene-cut boundaries detected${sampledNote}:
${shotLines}

Study the transcript for the spoken structure (a hook line, then each beat, then a call to action) and the frames for ANY on-screen text, memes, screen-recordings, title cards, or overlays and when they appear relative to the shots/transcript — that visual layer is exactly what "events" should capture.

Respond with ONLY the JSON object described above — no markdown code fences, no other text before or after it.`;
};

const buildRepairPrompt = (previousJsonText: string, errorText: string): string =>
  `Your previous response did not validate. Fix ONLY what's wrong below; keep everything else exactly the same.

Validation errors:
${errorText}

Your previous response:
${previousJsonText}

Respond with ONLY the corrected JSON object (the same {"rationale", "format"} shape) — no markdown code fences, no other text.`;

const extractJsonObject = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in model output: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
};

/** Loose shape checked before the strict FormatSchema pass, so a
 *  malformed-JSON or wrong-top-level-shape response gets a targeted repair
 *  prompt instead of a wall of FormatSchema errors about a document that
 *  isn't even in the right envelope yet. */
const RawOutputSchema = z.object({ rationale: z.string(), format: z.unknown() });

export const synthesize = async (draftId: string, analysis: Analysis): Promise<Draft> => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "synthesize: requires ANTHROPIC_API_KEY (put it in .env) — format synthesis is multimodal " +
        "(it reads sampled frames) and needs the Anthropic API; the render pipeline itself stays keyless.",
    );
  }
  const client = new Anthropic();
  // `||` (not `??`) deliberately — an EDITABLE_LLM_MODEL="" in .env is "not
  // set", not "use an empty model string" (which the API rejects outright).
  const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;
  const dir = authoringDir(draftId);

  const selectedShots = selectFramesForSynthesis(analysis.shots);
  const imageBlocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = selectedShots.flatMap(
    (shot) => {
      const framePath = path.join(dir, shot.frame);
      if (!fs.existsSync(framePath)) return [];
      const data = fs.readFileSync(framePath).toString("base64");
      return [
        {
          type: "text",
          text: `Frame for shot ${shot.index} (${shot.startSec.toFixed(2)}s-${shot.endSec.toFixed(2)}s):`,
        },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
      ];
    },
  );

  let content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
    { type: "text", text: buildSynthesisPrompt(analysis, selectedShots) },
    ...imageBlocks,
  ];

  for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt++) {
    const isLastAttempt = attempt === MAX_REPAIR_ROUNDS;
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content }],
    });
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      if (isLastAttempt) throw new Error("synthesize: model response had no text content");
      content = [{ type: "text", text: "Your previous response had no text content. Respond with ONLY the JSON object." }];
      continue;
    }
    const rawText = textBlock.text;

    let rawParsed: unknown;
    try {
      rawParsed = extractJsonObject(rawText);
    } catch (err) {
      if (isLastAttempt) throw err;
      content = [{ type: "text", text: buildRepairPrompt(rawText, (err as Error).message) }];
      continue;
    }

    const raw = RawOutputSchema.safeParse(rawParsed);
    if (!raw.success) {
      if (isLastAttempt) {
        throw new Error(
          `synthesize: model output didn't match the {rationale, format} envelope:\n${z.prettifyError(raw.error)}`,
        );
      }
      content = [{ type: "text", text: buildRepairPrompt(rawText, z.prettifyError(raw.error)) }];
      continue;
    }

    const candidate = {
      draftId,
      sourceUrl: analysis.sourceUrl,
      createdAt: new Date().toISOString(),
      rationale: raw.data.rationale,
      format: raw.data.format,
    };
    const validated = DraftSchema.safeParse(candidate);
    if (validated.success) return validated.data;

    if (isLastAttempt) {
      throw new Error(
        `synthesize: draft format failed validation after ${MAX_REPAIR_ROUNDS} repair attempt(s):\n${z.prettifyError(validated.error)}`,
      );
    }
    content = [{ type: "text", text: buildRepairPrompt(JSON.stringify(rawParsed), z.prettifyError(validated.error)) }];
  }

  throw new Error("synthesize: unreachable");
};

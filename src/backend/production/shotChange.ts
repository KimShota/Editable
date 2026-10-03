import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";
import type { ClipKind } from "./clips";
import { type ChangePlan, ChangePlanSchema, type ShotMessage } from "./shotChats";

/**
 * One turn of a shot's change chat: what the user asked → a plan Claude
 * proposes (shotChats.ts's ChangePlan). Claude only plans; nothing is spent
 * until the user presses Generate on the plan, which runs regen-clip with
 * it. It sees the shot as it is now (frames of the take on the timeline and
 * the still it was animated from) and the prompt that made it, and holds
 * every plan to what this kind of shot can actually do.
 */

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";

const SYSTEM = [
  "You help someone change one AI-generated shot of a short vertical video for a brand, from inside a video editor.",
  "A shot cannot be edited pixel by pixel. It changes by generating a new take: the video model animates a still image from a text prompt. You can change the prompt (motion, gesture, expression, camera) and/or edit the still first (what is in the frame: outfit, props, framing, setting, pose at the start).",
  "Answer with a plan:",
  "- motion: the COMPLETE new prompt for the video model, written from the current prompt with only the requested change made; keep everything else it says. null keeps the current prompt.",
  "- stillEdit: an instruction for editing the still, only when the change is about what the frame shows rather than how it moves; otherwise null. A still edit costs a little more and can drift the character's look, so prefer motion when either works.",
  "- motion and stillEdit both null with action \"regenerate\" is a plain re-roll: same prompt, a new random take (for \"just try again\").",
  "- action \"none\" when nothing should be generated: the request is unclear (ask one short question), it is something the editor already does for free (captions, on-screen titles, trimming, timing, speed, order, volume: say where), or this shot cannot do it (say why, briefly).",
  "- reply: 1 to 3 short sentences to the user, in the language they wrote in. State what the new take will change. Video models are not exact: never promise a precise result.",
  "- label: 2 to 5 words naming the change.",
  "Describe only what is visible. Never ask the video model for captions, on-screen text, logos or UI. If the user follows up on an earlier plan, build on it.",
].join("\n");

const KIND_RULES: Partial<Record<ClipKind, string>> = {
  talking:
    "This is a TALKING shot: the character speaks a recorded voice line, lip-synced by the model from that audio. The words cannot change here (that is a different tool: re-voicing the line in the script); if asked, use action none and say so. Any new prompt must keep the sentence that she says exactly the words of audio 1 with precise lip-sync. Gestures, expression, energy, framing and camera can change.",
  green:
    "This is a DEVICE shot: the laptop screen is a flat chroma-green area, and the real product screen recording is keyed onto it afterwards. Never describe anything on the screen, and keep the prompt's instruction that the display stays solid green with nothing on it; otherwise the video model draws fake UI that ruins the shot. If the user wants different content on the screen, use action none: the screen always shows the product's real footage. A still edit must keep the screen solid green. " +
    "How the screen gets there: the recording is pinned to the green area's four corners, found again in every frame. Anything that crosses or touches the screen (a finger, a hand, a pen, a cursor) breaks that and makes the composited screen warp, jitter or tear; and a MacBook is not a touchscreen anyway. So when the user reports the screen distorting, warping or glitching, the fix is to keep every hand and object off and away from the display for the whole shot (on the keyboard or trackpad, below the screen), not to ask for a rigid screen. If the still itself shows a hand on or in front of the screen, the motion must move it away at once, or use a stillEdit that puts the hand on the trackpad.",
  animate: "This is a B-ROLL shot: hands, objects or a scene, animated from the still. Keep it a natural phone-filmed moment.",
};

const imageBlock = (file: string): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: file.endsWith(".png") ? "image/png" : "image/jpeg", data: fs.readFileSync(file).toString("base64") },
});

export type ShotContext = {
  kind: ClipKind;
  shotId: string;
  /** What the script says happens in the shot. */
  action: string;
  durationSec: number;
  /** Talking shots: the line she says. */
  line?: string;
  characterName: string;
  /** The prompt that made the take on the timeline. */
  currentPrompt: string;
  /** The still it was animated from (small jpg). */
  still: string;
  /** Frames of the take on the timeline: start, middle, end (small jpgs). */
  frames: string[];
};

export const planShotChange = async (
  shot: ShotContext,
  history: ShotMessage[],
  request: string,
  opts: { model?: string; client?: Anthropic; costSink?: CostSink; ref?: string } = {},
): Promise<{ plan: ChangePlan; model: string }> => {
  const client = opts.client ?? new Anthropic({ timeout: 120_000 });
  // Earlier turns as a transcript: the plans are what Claude proposed, and
  // which of them became takes.
  const transcript = history
    .map((m) =>
      m.role === "user"
        ? `User: ${m.text}`
        : `You: ${m.text}${m.plan?.action === "regenerate" ? ` [plan: motion=${JSON.stringify(m.plan.motion)}, stillEdit=${JSON.stringify(m.plan.stillEdit)}${m.takeId ? ", generated" : ", not generated"}]` : ""}`,
    )
    .join("\n");
  const context = [
    `Shot ${shot.shotId}, ${shot.kind}, ${shot.durationSec.toFixed(1)}s. The character is ${shot.characterName}.`,
    `What the script says happens: ${shot.action}`,
    shot.line ? `The line she says: "${shot.line}"` : "",
    KIND_RULES[shot.kind] ?? "",
    `Current video prompt:\n${shot.currentPrompt}`,
    transcript ? `Conversation so far:\n${transcript}` : "",
    `The user now asks:\n${request}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.beta.messages.parse({
    model: opts.model ?? process.env.SHOT_CHAT_MODEL ?? DEFAULT_MODEL,
    max_tokens: 4_000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: FALLBACK_MODEL }],
    // A chat reply in the editor: quick beats deep here.
    output_config: { effort: "low", format: betaZodOutputFormat(ChangePlanSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "The still the current take was animated from:" },
          imageBlock(shot.still),
          { type: "text", text: "Frames of the current take (start, middle, end):" },
          ...shot.frames.map(imageBlock),
          { type: "text", text: context },
        ],
      },
    ],
  });
  await opts.costSink?.(anthropicCostEntry(response.model, response.usage, "shot_chat", { ref: opts.ref }));
  if (response.stop_reason === "refusal") {
    return { plan: { reply: "I can't help with that change.", action: "none", motion: null, stillEdit: null, label: "declined" }, model: response.model };
  }
  if (response.stop_reason === "max_tokens") throw new Error("shot chat: the reply was cut off");
  if (!response.parsed_output) throw new Error("shot chat: the reply did not match the plan schema");
  // motion and stillEdit both null with action "regenerate" is a plain
  // re-roll ("just try again"): same prompt, same still, a new random take.
  return { plan: response.parsed_output, model: response.model };
};

import type { LockedCharacter, SheetView } from "../character/schemas";
import type { AdaptedScript, RecreationSpec } from "./schemas";

/**
 * AdaptedScript → one storyboard still per shot. A shot whose screen is
 * product footage and fills the frame needs no generation: its still is a
 * frame of that footage. Every other shot is generated from the character's
 * sheet (who), the source keyframe (composition only) and, when the product
 * is on the device, a footage frame (what the screen shows).
 */

export type FrameRef = { role: "character" | "composition" | "screen"; key: string };

export type FramePlan =
  | { shotId: string; mode: "footage"; footageId: string }
  | { shotId: string; mode: "generate"; refs: FrameRef[]; prompt: string }
  | { shotId: string; mode: "text" };

/** The recurring set every character shot shares, so the series looks filmed in one place. */
export const DEFAULT_SET = "her bright, minimal apartment: white desk, warm daylight from a window, a plant, soft neutral wall";

const CHARACTER_VIEW: Partial<Record<AdaptedScript["shots"][number]["treatment"], SheetView>> = {
  character_talking: "front",
  character_with_device: "with_prop",
  broll: "three_quarter",
  device_closeup: "front",
};

const ordinal = ["image 1", "image 2", "image 3", "image 4"];

/** The display of a green-screen frame: real footage is keyed onto it later
 *  (production/greenscreen.py), so it must be flat green edge to edge. */
export const GREEN_SCREEN =
  "The laptop's entire display is a flat, solid, evenly lit chroma-key green (#00FF00) from edge to edge: no windows, menu bar, dock, text, glare or reflections on it. The whole screen and its bezel stay fully visible. " +
  "The green gives off no light: hands, skin, keyboard, trackpad and everything else keep their natural neutral colours, with no green tint or reflection anywhere.";

export const framePrompt = (
  shot: AdaptedScript["shots"][number],
  character: LockedCharacter,
  refs: FrameRef[],
  set: string,
  opts: { greenScreen?: boolean } = {},
): string => {
  const at = (role: FrameRef["role"]) => ordinal[refs.findIndex((r) => r.role === role)];
  const name = character.concept.name;
  const lines = [
    "A storyboard frame for a vertical 9:16 short-form video, filmed on a smartphone, photorealistic.",
    shot.treatment === "device_closeup"
      ? `A close-up of a MacBook screen (a laptop, not a tablet or phone). Only ${name}'s hand is in frame: the same skin tone and nails as the woman in ${at("character")}.`
      : `The person is ${name}, the woman in ${at("character")}: the same person, with her exact face, hair, skin, outfit and jewellery. ${character.concept.appearance}`,
    `Copy only the composition of ${at("composition")}: camera distance, angle, framing, pose and where things sit in the frame. Do not copy its person, face, hair, clothes, room, device, text, captions or watermark, and never copy what is on its screen.`,
  ];
  if (opts.greenScreen) lines.push(GREEN_SCREEN);
  else if (at("screen")) lines.push(`The laptop screen shows exactly the screen in ${at("screen")}, sharp and legible. Do not change or invent any of its interface.`);
  else if (shot.otherScreen) lines.push(`The laptop screen shows: ${shot.otherScreen}. Generic interface, no real brand logos.`);
  lines.push(`Action: ${shot.action}`);
  if (shot.treatment !== "device_closeup" && shot.treatment !== "screen_fill") lines.push(`Setting: ${set}.`);
  lines.push("No captions, subtitles, text overlays or watermarks.");
  return lines.join("\n");
};

export const planFrames = (script: AdaptedScript, spec: RecreationSpec, character: LockedCharacter, footageFrameKey: (clipId: string) => string, set = DEFAULT_SET): FramePlan[] =>
  script.shots.map((shot) => {
    if (shot.treatment === "screen_fill" && shot.footageId) return { shotId: shot.shotId, mode: "footage", footageId: shot.footageId };
    if (shot.treatment === "text_card") return { shotId: shot.shotId, mode: "text" };

    const refs: FrameRef[] = [];
    const view = CHARACTER_VIEW[shot.treatment];
    const characterKey = view ? (character.sheet[view] ?? character.baseImageKey) : undefined;
    if (characterKey) refs.push({ role: "character", key: characterKey });
    const keyframe = spec.shots.find((s) => s.id === shot.shotId)?.keyframes[0]?.key;
    if (keyframe) refs.push({ role: "composition", key: keyframe });
    if (shot.footageId) refs.push({ role: "screen", key: footageFrameKey(shot.footageId) });
    return { shotId: shot.shotId, mode: "generate", refs, prompt: framePrompt(shot, character, refs, set) };
  });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A local review page: one card per shot with its still, what is said over
 *  it and its on-screen text. `image` maps a shot to a path relative to the page. */
export const boardHtml = (script: AdaptedScript, image: (shotId: string) => string | null): string => {
  const cards = script.shots
    .map((shot) => {
      const said = script.lines.filter((l) => l.shotIds.includes(shot.shotId)).map((l) => `<p class="said">“${esc(l.text)}”</p>`).join("");
      const text = shot.textOnScreen.map((t) => `<span class="ost">${esc(t.text)}</span>`).join("");
      const src = image(shot.shotId);
      const screen = shot.footageId ? `real footage: ${esc(shot.footageId)}` : shot.otherScreen ? `screen: ${esc(shot.otherScreen)}` : "";
      return `<figure>
  <div class="still">${src ? `<img src="${esc(src)}" alt="${esc(shot.shotId)}">` : `<div class="missing">no still</div>`}${text ? `<div class="overlay">${text}</div>` : ""}</div>
  <figcaption><b>${esc(shot.shotId)}</b> · ${shot.sourceStartSec.toFixed(1)}–${shot.sourceEndSec.toFixed(1)}s · ${esc(shot.treatment.replace(/_/g, " "))}
  <p>${esc(shot.action)}</p>${screen ? `<p class="screen">${screen}</p>` : ""}${said}</figcaption>
</figure>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storyboard ${esc(script.sourceId)}</title>
<style>
  :root { --bg: #f6f6f4; --card: #fff; --ink: #1d1d1f; --ink2: #6b6b70; --line: #e4e4e0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #1c1c1f; --ink: #f2f2f4; --ink2: #9a9aa2; --line: #2c2c30; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, system-ui, sans-serif; }
  header { max-width: 1200px; margin: 0 auto 20px; } h1 { font-size: 20px; margin: 0 0 4px; } header p { margin: 2px 0; color: var(--ink2); }
  main { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .still { position: relative; aspect-ratio: 9 / 16; background: #000; display: flex; align-items: center; }
  .still img { width: 100%; height: 100%; object-fit: contain; }
  .missing { color: #888; margin: auto; }
  .overlay { position: absolute; left: 8px; right: 8px; top: 38%; text-align: center; }
  .ost { display: inline-block; background: rgba(0,0,0,.6); color: #fff; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin: 2px; }
  figcaption { padding: 10px 12px 12px; } figcaption p { margin: 6px 0 0; }
  .screen { color: var(--ink2); font-size: 12px; } .said { font-style: italic; }
</style></head><body>
<header><h1>${esc(script.sourceId)} → ${esc(script.brand)} · comment ${esc(script.ctaKeyword)}</h1><p>${esc(script.angle)}</p><p>${esc(script.postCaption)} ${script.hashtags.map((h) => `#${esc(h)}`).join(" ")}</p></header>
<main>
${cards}
</main></body></html>
`;
};

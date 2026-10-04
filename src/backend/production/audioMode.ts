import type { Storage } from "../storage";

/**
 * Whose voice a brand's videos speak with.
 *
 *   native   the character speaks the line with the audio the video model
 *            generates with the clip (the default). No ElevenLabs step: the
 *            timeline follows the source's own speech slots, and captions are
 *            timed from what the clip says.
 *   revoice  every line is ElevenLabs speech in the character's locked voice,
 *            the shots are timed to it, and the clip is lip-synced to it.
 *
 * Read from brands/<brand>/production.json ({ "audioMode": "revoice" }); a
 * brand without the file gets the default. The locked voice stays on the
 * character either way: it is what Re-voice uses in the editor.
 */
export type AudioMode = "native" | "revoice";

export const DEFAULT_AUDIO_MODE: AudioMode = "native";

export const audioModeKey = (brand: string): string => `brands/${brand}/production.json`;

export const parseAudioMode = (raw: unknown): AudioMode => {
  const mode = (raw as { audioMode?: unknown } | null)?.audioMode;
  if (mode === undefined) return DEFAULT_AUDIO_MODE;
  if (mode === "native" || mode === "revoice") return mode;
  throw new Error(`production.json: audioMode must be "native" or "revoice", got ${JSON.stringify(mode)}`);
};

export const readAudioMode = async (storage: Storage, brand: string): Promise<AudioMode> => {
  const key = audioModeKey(brand);
  if (!(await storage.exists(key))) return DEFAULT_AUDIO_MODE;
  const fs = await import("node:fs");
  return parseAudioMode(JSON.parse(fs.readFileSync(await storage.localPath(key), "utf8")));
};

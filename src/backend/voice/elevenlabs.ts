import type { CostEntry, CostSink } from "../cost/ledger";

/**
 * ElevenLabs: voice design (a voice from a text description), saving a
 * designed voice to the account, and text-to-speech. The character step
 * designs a mascot's voice with it; shot generation (M1 day 5) speaks every
 * script line through `textToSpeech`.
 *
 * Plain fetch against the REST API (https://elevenlabs.io/docs/api-reference):
 * three endpoints don't justify an SDK dependency.
 */

const API = "https://api.elevenlabs.io";

export const VOICE_DESIGN_MODEL = process.env.ELEVENLABS_DESIGN_MODEL ?? "eleven_ttv_v3";
export const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_v4";

/** Estimated USD per 1,000 characters. ElevenLabs bills characters against a
 *  monthly subscription, not per call; this is the Creator plan's effective
 *  rate ($22 / 100k), so the ledger still sums to a cost per video. */
const USD_PER_1K_CHARS = 0.22;

export const elevenLabsCostEntry = (model: string, characters: number, operation: string, extra: { brandId?: string | null; ref?: string | null } = {}): CostEntry => ({
  ...extra,
  provider: "elevenlabs",
  model,
  operation,
  units: { characters },
  usd: (characters / 1000) * USD_PER_1K_CHARS,
});

const apiKey = (): string => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("elevenlabs: ELEVENLABS_API_KEY is not set");
  return key;
};

const call = async (path: string, body: unknown, timeoutMs = 120_000): Promise<Response> => {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`elevenlabs ${path}: ${res.status} ${(await res.text()).slice(0, 1000)}`);
  return res;
};

/** Characters billed for a call: the `character-cost` header when present,
 *  else the length of the text sent. */
const billedChars = (res: Response, text: string): number => {
  const header = Number(res.headers.get("character-cost"));
  return Number.isFinite(header) && header > 0 ? header : text.length;
};

export type VoicePreview = { generatedVoiceId: string; audio: Buffer; mediaType: string; durationSecs: number };

export const DESIGN_TEXT_MIN = 100;
export const DESIGN_TEXT_MAX = 1000;

/** A few candidate voices for one description, each speaking `text` (100-1000
 *  characters). Nothing is saved to the account until `saveDesignedVoice`. */
export const designVoice = async (
  description: string,
  text: string,
  opts: { costSink?: CostSink; ref?: string; seed?: number } = {},
): Promise<VoicePreview[]> => {
  if (text.length < DESIGN_TEXT_MIN || text.length > DESIGN_TEXT_MAX) {
    throw new Error(`elevenlabs: voice design text must be ${DESIGN_TEXT_MIN}-${DESIGN_TEXT_MAX} characters, got ${text.length}`);
  }
  const res = await call("/v1/text-to-voice/design", { voice_description: description, model_id: VOICE_DESIGN_MODEL, text, seed: opts.seed });
  const json = (await res.json()) as { previews: { generated_voice_id: string; audio_base_64: string; media_type: string; duration_secs: number }[] };
  await opts.costSink?.(elevenLabsCostEntry(VOICE_DESIGN_MODEL, billedChars(res, text), "voice_design", { ref: opts.ref }));
  return json.previews.map((p) => ({
    generatedVoiceId: p.generated_voice_id,
    audio: Buffer.from(p.audio_base_64, "base64"),
    mediaType: p.media_type,
    durationSecs: p.duration_secs,
  }));
};

/** Saves a designed preview as a voice on the account (uses one voice slot). */
export const saveDesignedVoice = async (args: {
  generatedVoiceId: string;
  name: string;
  description: string;
  notSelectedIds?: string[];
}): Promise<{ voiceId: string; name: string }> => {
  const res = await call("/v1/text-to-voice", {
    voice_name: args.name,
    voice_description: args.description,
    generated_voice_id: args.generatedVoiceId,
    played_not_selected_voice_ids: args.notSelectedIds,
  });
  const json = (await res.json()) as { voice_id: string; name: string };
  return { voiceId: json.voice_id, name: json.name };
};

/** Speech for one line, as mp3 (44.1 kHz, 128 kbps). */
export const textToSpeech = async (
  voiceId: string,
  text: string,
  opts: { model?: string; costSink?: CostSink; ref?: string; brandId?: string | null } = {},
): Promise<Buffer> => {
  const model = opts.model ?? TTS_MODEL;
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, { text, model_id: model });
  const audio = Buffer.from(await res.arrayBuffer());
  await opts.costSink?.(elevenLabsCostEntry(model, billedChars(res, text), "tts", { ref: opts.ref, brandId: opts.brandId }));
  return audio;
};

export type TimedWord = { text: string; startSec: number; endSec: number };
export type CharacterAlignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

/** Groups ElevenLabs' per-character timings into words (split on whitespace). */
export const wordsFromAlignment = (a: CharacterAlignment): TimedWord[] => {
  const words: TimedWord[] = [];
  let current: TimedWord | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    if (!current) current = { text: "", startSec: a.character_start_times_seconds[i], endSec: a.character_end_times_seconds[i] };
    current.text += ch;
    current.endSec = a.character_end_times_seconds[i];
  });
  if (current) words.push(current);
  return words;
};

/** Speech for one line plus when each word is spoken (for captions and cuts). */
export const textToSpeechTimed = async (
  voiceId: string,
  text: string,
  opts: { model?: string; costSink?: CostSink; ref?: string; brandId?: string | null } = {},
): Promise<{ audio: Buffer; words: TimedWord[] }> => {
  const model = opts.model ?? TTS_MODEL;
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, { text, model_id: model });
  const json = (await res.json()) as { audio_base64: string; alignment: CharacterAlignment | null; normalized_alignment: CharacterAlignment | null };
  await opts.costSink?.(elevenLabsCostEntry(model, billedChars(res, text), "tts", { ref: opts.ref, brandId: opts.brandId }));
  const alignment = json.alignment ?? json.normalized_alignment;
  if (!alignment) throw new Error("elevenlabs: speech came back without timestamps");
  return { audio: Buffer.from(json.audio_base64, "base64"), words: wordsFromAlignment(alignment) };
};

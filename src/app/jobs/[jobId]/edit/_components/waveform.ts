export type DecodedAudio = {
  channelData: Float32Array;
  sampleRate: number;
  /** Loudest sample across the WHOLE decoded file, not just whatever slice
   *  is currently visible — every clip's bars are normalized against this
   *  one shared value (see computePeaks) so a trim doesn't restretch the
   *  remaining waveform to fill the height, which would read as "the sound
   *  changed" rather than "the clip got shorter." */
  peakAbs: number;
};

const cache = new Map<string, Promise<DecodedAudio | null>>();

async function decode(url: string): Promise<DecodedAudio | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    let peakAbs = 0;
    for (let i = 0; i < channelData.length; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > peakAbs) peakAbs = abs;
    }
    const decoded = { channelData, sampleRate: audioBuffer.sampleRate, peakAbs };
    ctx.close();
    return decoded;
  } catch {
    // A muted/non-audio source, an unsupported codec, or a fetch failure —
    // the waveform is a nicety over the plain color clip, so fail silently.
    return null;
  }
}

/** One decode per source file, shared across every clip that points at it —
 *  a timeline commonly has several clips (segments, repeats) referencing the
 *  same underlying video, and decoding a whole file's audio track is too
 *  expensive to repeat per clip. */
export function getDecodedAudio(url: string): Promise<DecodedAudio | null> {
  let entry = cache.get(url);
  if (!entry) {
    entry = decode(url);
    cache.set(url, entry);
  }
  return entry;
}

/** Downsamples a slice of decoded audio into per-bin peak amplitudes (0..1),
 *  one bar per bin rather than one per sample. `normalizeTo` is the WHOLE
 *  file's own peak (DecodedAudio.peakAbs), not this slice's — so trimming a
 *  clip shows fewer bars of the same shape/height instead of the remaining
 *  bars rescaling to fill the box. */
export function computePeaks(channelData: Float32Array, bins: number, normalizeTo: number): Float32Array {
  const samplesPerBin = Math.max(1, Math.floor(channelData.length / bins));
  const peaks = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? channelData.length : start + samplesPerBin;
    let peak = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > peak) peak = abs;
    }
    peaks[i] = normalizeTo > 0 ? peak / normalizeTo : 0;
  }
  return peaks;
}

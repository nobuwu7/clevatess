// Audio analysis in the browser: decode once, then find silences and cut WAV chunks
// for transcription. Nothing leaves the device here.

const decoded = new Map<string, AudioBuffer>();

export async function decodeAsset(assetId: string, blob: Blob): Promise<AudioBuffer> {
  const hit = decoded.get(assetId);
  if (hit) return hit;
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  decoded.set(assetId, buf);
  return buf;
}

/** Mixdown to mono Float32 at the buffer's native rate. */
function mono(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

export interface SilenceOptions {
  thresholdDb?: number; // below this RMS level counts as silence
  minDuration?: number; // shortest silence worth cutting
  padding?: number; // keep this much air either side of speech
}

/** Return silent ranges in source time. */
export function findSilences(buf: AudioBuffer, opts: SilenceOptions = {}): { start: number; end: number }[] {
  const thresholdDb = opts.thresholdDb ?? -38;
  const minDuration = opts.minDuration ?? 0.45;
  const padding = opts.padding ?? 0.12;
  const data = mono(buf);
  const win = Math.floor(buf.sampleRate * 0.02); // 20ms windows
  const threshold = Math.pow(10, thresholdDb / 20);
  const ranges: { start: number; end: number }[] = [];
  let silentFrom = -1;
  const total = Math.floor(data.length / win);
  for (let w = 0; w <= total; w++) {
    let rms = 0;
    if (w < total) {
      let sum = 0;
      const o = w * win;
      for (let i = 0; i < win; i++) sum += data[o + i] * data[o + i];
      rms = Math.sqrt(sum / win);
    }
    const silent = w < total && rms < threshold;
    if (silent && silentFrom < 0) silentFrom = w;
    if (!silent && silentFrom >= 0) {
      const s = (silentFrom * win) / buf.sampleRate;
      const e = (w * win) / buf.sampleRate;
      if (e - s >= minDuration) {
        const ps = s === 0 ? 0 : s + padding;
        const pe = w >= total ? e : e - padding;
        if (pe - ps > 0.05) ranges.push({ start: ps, end: pe });
      }
      silentFrom = -1;
    }
  }
  return ranges;
}

/** Peaks for drawing a waveform on the timeline. */
export function peaks(buf: AudioBuffer, buckets: number): Float32Array {
  const data = buf.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / buckets));
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const o = b * size;
    for (let i = 0; i < size; i += 8) max = Math.max(max, Math.abs(data[o + i] || 0));
    out[b] = max;
  }
  return out;
}

/** Resample to 16kHz mono and slice into WAV chunks small enough for serverless request limits. */
export async function wavChunks(buf: AudioBuffer, chunkSeconds = 90): Promise<{ offset: number; blob: Blob }[]> {
  const rate = 16000;
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const pcm = rendered.getChannelData(0);
  const chunks: { offset: number; blob: Blob }[] = [];
  const per = chunkSeconds * rate;
  for (let o = 0; o < pcm.length; o += per) {
    chunks.push({ offset: o / rate, blob: encodeWav(pcm.subarray(o, Math.min(pcm.length, o + per)), rate) });
  }
  return chunks;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

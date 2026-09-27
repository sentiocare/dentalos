/**
 * Raw audio helpers for the voice pipeline. Telephony audio is 16-bit signed little-endian PCM, mono,
 * usually at 8 kHz ("slin"). Everything here works on Uint8Array byte buffers of that format.
 */

export const TELEPHONY_SAMPLE_RATE = 8000;

/** Samples view over PCM16 LE bytes (copies if the buffer is not 2-byte aligned). */
export function samplesOf(pcm: Uint8Array): Int16Array {
  if (pcm.byteOffset % 2 === 0 && pcm.byteLength % 2 === 0)
    return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const copy = new Uint8Array(pcm.byteLength - (pcm.byteLength % 2));
  copy.set(pcm.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

export function bytesOf(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function silence(ms: number, sampleRate = TELEPHONY_SAMPLE_RATE): Uint8Array {
  return new Uint8Array(Math.round((sampleRate * ms) / 1000) * 2);
}

export function durationMs(pcm: Uint8Array, sampleRate = TELEPHONY_SAMPLE_RATE): number {
  return Math.round((pcm.byteLength / 2 / sampleRate) * 1000);
}

/** Root-mean-square level of a frame, 0–32767. */
export function rms(pcm: Uint8Array): number {
  const s = samplesOf(pcm);
  if (s.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / s.length);
}

/** Linear-interpolation resampling. Good enough for speech between 8, 16, 22.05 and 24 kHz. */
export function resample(pcm: Uint8Array, from: number, to: number): Uint8Array {
  if (from === to) return pcm;
  const input = samplesOf(pcm);
  const length = Math.max(1, Math.floor((input.length * to) / from));
  const out = new Int16Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = x - i0;
    out[i] = Math.round((input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac);
  }
  return bytesOf(out);
}

/** Wraps PCM16 mono in a WAV container (for speech-to-text APIs that want a file). */
export function encodeWav(pcm: Uint8Array, sampleRate = TELEPHONY_SAMPLE_RATE): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  return concatBytes([new Uint8Array(header.buffer), pcm]);
}

/** Reads a PCM16 WAV file (mono, or the first channel of stereo). Throws on anything else. */
export function decodeWav(wav: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (wav.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  while (offset + 8 <= wav.byteLength) {
    const id = tag(offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      // Streaming encoders write 0 or 0xFFFFFFFF as the size; take the rest of the file then.
      if (size === 0 || size === 0xffffffff || body + size > wav.byteLength) size = wav.byteLength - body;
      if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
      const data = wav.subarray(body, body + size - (size % 2));
      if (channels === 1) return { pcm: new Uint8Array(data), sampleRate };
      const all = samplesOf(new Uint8Array(data));
      const mono = new Int16Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels]!;
      return { pcm: bytesOf(mono), sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

/** Splits PCM into chunks of `bytes`, padding the last one with silence. */
export function chunk(pcm: Uint8Array, bytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < pcm.byteLength; i += bytes) {
    const part = pcm.subarray(i, i + bytes);
    if (part.byteLength === bytes) out.push(part);
    else {
      const padded = new Uint8Array(bytes);
      padded.set(part);
      out.push(padded);
    }
  }
  return out;
}

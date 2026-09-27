import { bytesOf, concatBytes, durationMs, samplesOf } from "../audio";
import { FakeSupport } from "../fake-support";
import type { SpeechProvider, SynthesizeInput, TranscribeInput } from "./types";

/**
 * Fake speech: "synthesised" audio carries its text inside the samples, and "transcription" reads it back.
 * That lets tests push real audio through the whole pipeline (voice activity detection, barge-in,
 * endpointing) and still know exactly what was said. The encoded audio is loud, so it counts as speech.
 */
const MAGIC = [30001, -30001, 30002, -30002];
const MIN_MS = 400;
const MS_PER_WORD = 60;

export function fakeSpeechAudio(text: string, sampleRate = 8000): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const words = text.split(/\s+/).filter(Boolean).length;
  const total = Math.max(
    Math.round((sampleRate * Math.max(MIN_MS, words * MS_PER_WORD)) / 1000),
    MAGIC.length + 2 + bytes.length + 8,
  );
  const s = new Int16Array(total);
  s.set(MAGIC, 0);
  s[4] = bytes.length & 0x7fff;
  s[5] = bytes.length >> 15;
  for (let i = 0; i < bytes.length; i++) s[6 + i] = 6000 + bytes[i]! * 80;
  // Loud filler so the audio reads as speech for its whole length.
  for (let i = 6 + bytes.length; i < total; i++) s[i] = i % 2 ? 7000 : -7000;
  return bytesOf(s);
}

/** Finds and decodes every fake utterance in a buffer (joined with spaces), or null if there is none. */
export function decodeFakeSpeech(pcm: Uint8Array): string | null {
  const s = samplesOf(pcm);
  const found: string[] = [];
  for (let i = 0; i + 6 <= s.length; i++) {
    if (s[i] !== MAGIC[0] || s[i + 1] !== MAGIC[1] || s[i + 2] !== MAGIC[2] || s[i + 3] !== MAGIC[3])
      continue;
    const length = (s[i + 4]! & 0x7fff) | (s[i + 5]! << 15);
    if (i + 6 + length > s.length) break;
    const bytes = new Uint8Array(length);
    for (let k = 0; k < length; k++) bytes[k] = Math.round((s[i + 6 + k]! - 6000) / 80);
    found.push(new TextDecoder().decode(bytes));
    i += 6 + length;
  }
  return found.length ? found.join(" ") : null;
}

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = "fake-speech";
  readonly support = new FakeSupport(this.name, "fake-speech-secret");
  readonly languages = ["hi-IN", "en-IN"];
  readonly synthesized: { text: string; language: string }[] = [];
  readonly transcribed: { text: string; language: string | null }[] = [];
  /** Extra delay per call, to test latency handling (filler phrases, timeouts). */
  delayMs = 0;
  /** Transcript for audio that carries no fake speech (e.g. a real WhatsApp voice note in tests). */
  transcriptFor: (audio: Uint8Array) => { text: string; language: string } = () => ({
    text: "mujhe kal appointment chahiye",
    language: "hi-IN",
  });

  private async wait() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async transcribe(input: TranscribeInput) {
    this.support.throwIfScripted();
    await this.wait();
    const decoded = decodeFakeSpeech(input.audio);
    const result =
      decoded !== null
        ? { text: decoded, language: /[ऀ-ॿ]/.test(decoded) ? "hi-IN" : "en-IN" }
        : input.format === "file"
          ? this.transcriptFor(input.audio)
          : { text: "", language: null };
    this.transcribed.push(result);
    return {
      ...result,
      audioMs: input.format === "pcm16" ? durationMs(input.audio, input.sampleRate) : 5000,
    };
  }

  async synthesize(input: SynthesizeInput) {
    this.support.throwIfScripted();
    await this.wait();
    this.synthesized.push({ text: input.text, language: input.language });
    return {
      pcm: concatBytes([fakeSpeechAudio(input.text, input.sampleRate)]),
      sampleRate: input.sampleRate,
      characters: input.text.length,
    };
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

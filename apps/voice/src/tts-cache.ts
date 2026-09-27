import type { SpeechProvider } from "@dentalos/adapters";

/**
 * Most of what the assistant says is fixed text (greeting, notices, questions), so synthesised audio is kept
 * in memory and reused across calls: those replies start playing instantly and cost nothing.
 */
export class TtsCache {
  private readonly entries = new Map<string, Uint8Array>();
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 500) {}

  async get(
    speech: SpeechProvider,
    text: string,
    language: string,
    sampleRate: number,
  ): Promise<{ pcm: Uint8Array; billedChars: number }> {
    const key = `${language}|${sampleRate}|${text}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { pcm: cached, billedChars: 0 };
    }
    this.misses++;
    const out = await speech.synthesize({ text, language, sampleRate });
    this.entries.set(key, out.pcm);
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return { pcm: out.pcm, billedChars: out.characters };
  }
}

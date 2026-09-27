import { decodeWav, durationMs, encodeWav, resample } from "../audio";
import { ProviderError, type HealthStatus } from "../common";
import type { SpeechProvider, SynthesizeInput, TranscribeInput } from "./types";

/**
 * Sarvam AI (Indian languages, hosted in India): speech-to-text (Saarika) and text-to-speech (Bulbul) over
 * their REST API. Docs: https://docs.sarvam.ai. Model and voice names are configuration, so a new Sarvam
 * model is a Railway variable change, not a code change.
 */
export interface SarvamConfig {
  apiKey: string;
  baseUrl?: string;
  sttModel?: string;
  ttsModel?: string;
  /** Voice name, e.g. "anushka". */
  speaker?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SarvamSpeechProvider implements SpeechProvider {
  readonly name = "sarvam";
  readonly languages = [
    "hi-IN",
    "en-IN",
    "bn-IN",
    "ta-IN",
    "te-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "gu-IN",
    "pa-IN",
    "od-IN",
  ];
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: SarvamConfig) {
    this.base = (config.baseUrl ?? "https://api.sarvam.ai").replace(/\/$/, "");
    this.fetch = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    const started = Date.now();
    try {
      res = await this.fetch(`${this.base}${path}`, {
        ...init,
        headers: { "api-subscription-key": this.config.apiKey, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      throw new ProviderError(
        this.name,
        name === "TimeoutError" ? "timeout" : "network",
        `Sarvam unreachable (${name}) after ${Date.now() - started} ms`,
        true,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String((json.error as { code?: string } | undefined)?.code ?? res.status);
      throw new ProviderError(
        this.name,
        code,
        `Sarvam error ${res.status}`,
        res.status >= 500 || res.status === 429,
      );
    }
    return json;
  }

  async transcribe(input: TranscribeInput) {
    const form = new FormData();
    const file =
      input.format === "pcm16"
        ? new Blob([encodeWav(input.audio, input.sampleRate)], { type: "audio/wav" })
        : new Blob([input.audio], { type: input.mimeType.split(";")[0]! });
    form.append("file", file, input.format === "pcm16" ? "audio.wav" : `audio.${extension(input.mimeType)}`);
    form.append("model", this.config.sttModel ?? "saarika:v2.5");
    form.append("language_code", !input.language || input.language === "auto" ? "unknown" : input.language);
    const json = await this.call("/speech-to-text", { method: "POST", body: form });
    return {
      text: String(json.transcript ?? "").trim(),
      language: typeof json.language_code === "string" ? json.language_code : null,
      audioMs: input.format === "pcm16" ? durationMs(input.audio, input.sampleRate) : 0,
    };
  }

  async synthesize(input: SynthesizeInput) {
    const json = await this.call("/text-to-speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        target_language_code: input.language,
        speaker: input.voice ?? this.config.speaker ?? "anushka",
        model: this.config.ttsModel ?? "bulbul:v2",
        speech_sample_rate: input.sampleRate,
        pace: input.pace ?? 1,
        enable_preprocessing: true,
      }),
    });
    const audios = json.audios as string[] | undefined;
    if (!audios?.length) throw new ProviderError(this.name, "no_audio", "Sarvam returned no audio", true);
    const parts = audios.map((b64) => decodeWav(new Uint8Array(Buffer.from(b64, "base64"))));
    const pcm = Buffer.concat(parts.map((p) => resample(p.pcm, p.sampleRate, input.sampleRate)));
    return { pcm: new Uint8Array(pcm), sampleRate: input.sampleRate, characters: input.text.length };
  }

  async healthCheck(): Promise<HealthStatus> {
    // No free status endpoint; a tiny synthesis would cost money every 30 s. Configuration is checked
    // here, and live failures show up in call metrics and the voice service's own health.
    return this.config.apiKey ? { ok: true } : { ok: false, detail: "SARVAM_API_KEY missing" };
  }
}

function extension(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim();
  return (
    {
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/aac": "aac",
      "audio/amr": "amr",
      "audio/wav": "wav",
      "audio/webm": "webm",
    }[type] ?? "ogg"
  );
}

import type { ProviderBase } from "../common";

/**
 * Speech in and out for our own voice pipeline (PLAN D4, founder decision 27 Sep 2026): we run the
 * conversation ourselves and use a provider only to turn audio into text and text into audio. Sarvam in
 * production; any provider with these two calls fits.
 */
export interface SpeechProvider extends ProviderBase {
  /** BCP-47 codes this provider can recognise and speak, e.g. "hi-IN", "en-IN". */
  readonly languages: string[];
  transcribe(input: TranscribeInput): Promise<Transcript>;
  synthesize(input: SynthesizeInput): Promise<SynthesizedSpeech>;
}

export type TranscribeInput =
  | {
      /** Raw PCM16 mono from a phone call. */
      format: "pcm16";
      audio: Uint8Array;
      sampleRate: number;
      /** "auto" lets the provider detect the language. */
      language?: string | "auto";
    }
  | {
      /** A file, e.g. a WhatsApp voice note (ogg/opus). */
      format: "file";
      audio: Uint8Array;
      mimeType: string;
      language?: string | "auto";
    };

export interface Transcript {
  text: string;
  /** Detected language (BCP-47), or null when unknown. */
  language: string | null;
  /** Audio length the provider billed, for metering. */
  audioMs: number;
}

export interface SynthesizeInput {
  text: string;
  language: string;
  /** Output sample rate; telephony uses 8000. */
  sampleRate: number;
  voice?: string;
  /** 1 = normal speed. */
  pace?: number;
}

export interface SynthesizedSpeech {
  /** PCM16 mono at `sampleRate`. */
  pcm: Uint8Array;
  sampleRate: number;
  /** Characters billed, for metering. */
  characters: number;
}

import { concatBytes, rms } from "@dentalos/adapters";

/**
 * Finds the caller's utterances in the call audio: voice activity detection with an adaptive noise floor
 * (phone lines and clinics are noisy), then "endpointing": the utterance ends after a stretch of silence.
 * Works on frame counts, not wall-clock time, so it behaves the same in tests as on a live call.
 */
export interface EndpointerOptions {
  sampleRate: number;
  /** Speech must last this long to count (filters clicks and coughs). */
  minSpeechMs?: number;
  /** Silence that ends an utterance. Shorter for yes/no answers, longer for names. */
  silenceMs?: number;
  /** An utterance is cut here even if the caller keeps talking. */
  maxUtteranceMs?: number;
  /** Audio kept from just before speech was detected, so first syllables are not lost. */
  preRollMs?: number;
  /** Lowest level that can count as speech (0–32767). */
  minLevel?: number;
}

export type EndpointEvent =
  { type: "speech_start" } | { type: "utterance"; pcm: Uint8Array; durationMs: number };

const FRAME_MS = 20;

export class Endpointer {
  private readonly frameBytes: number;
  private readonly opts: Required<EndpointerOptions>;
  private pending = new Uint8Array(0);
  private noiseFloor = 200;
  private state: "idle" | "speech" = "idle";
  private speechRun = 0;
  private silenceRun = 0;
  private preRoll: Uint8Array[] = [];
  private utterance: Uint8Array[] = [];

  constructor(options: EndpointerOptions) {
    this.opts = {
      minSpeechMs: 120,
      silenceMs: 800,
      maxUtteranceMs: 15_000,
      preRollMs: 300,
      minLevel: 600,
      ...options,
    };
    this.frameBytes = (options.sampleRate / 1000) * FRAME_MS * 2;
  }

  get speaking() {
    return this.state === "speech";
  }

  setSilenceMs(ms: number) {
    this.opts.silenceMs = ms;
  }

  /** Forget any partial utterance (e.g. audio heard while a notice that cannot be interrupted played). */
  reset() {
    this.state = "idle";
    this.speechRun = 0;
    this.silenceRun = 0;
    this.utterance = [];
    this.preRoll = [];
  }

  push(pcm: Uint8Array): EndpointEvent[] {
    const events: EndpointEvent[] = [];
    let data = this.pending.byteLength ? concatBytes([this.pending, pcm]) : pcm;
    while (data.byteLength >= this.frameBytes) {
      const frame = data.slice(0, this.frameBytes);
      data = data.subarray(this.frameBytes);
      const event = this.frame(frame);
      if (event) events.push(event);
    }
    this.pending = new Uint8Array(data);
    return events;
  }

  private frame(frame: Uint8Array): EndpointEvent | null {
    const level = rms(frame);
    const threshold = Math.max(this.opts.minLevel, this.noiseFloor * 3.5);
    const isSpeech = level > threshold;
    if (!isSpeech) this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;

    if (this.state === "idle") {
      this.preRoll.push(frame);
      const keep = Math.ceil(this.opts.preRollMs / FRAME_MS) + Math.ceil(this.opts.minSpeechMs / FRAME_MS);
      if (this.preRoll.length > keep) this.preRoll.shift();
      this.speechRun = isSpeech ? this.speechRun + 1 : 0;
      if (this.speechRun * FRAME_MS >= this.opts.minSpeechMs) {
        this.state = "speech";
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.silenceRun = 0;
        return { type: "speech_start" };
      }
      return null;
    }

    this.utterance.push(frame);
    this.silenceRun = isSpeech ? 0 : this.silenceRun + 1;
    const durationMs = this.utterance.length * FRAME_MS;
    if (this.silenceRun * FRAME_MS >= this.opts.silenceMs || durationMs >= this.opts.maxUtteranceMs) {
      const pcm = concatBytes(this.utterance);
      this.reset();
      return { type: "utterance", pcm, durationMs };
    }
    return null;
  }
}

/** How long to wait for silence, by what the assistant just asked. */
export const SILENCE_MS: Record<"open" | "yes_no" | "name" | "choice", number> = {
  open: 800,
  yes_no: 600,
  name: 1000,
  choice: 700,
};

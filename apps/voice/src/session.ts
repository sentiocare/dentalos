import type { LLMProvider, SpeechProvider, StreamEvent, TelephonyProvider } from "@dentalos/adapters";
import {
  endCall,
  loadFacts,
  recordLatency,
  routeInboundCall,
  runVoiceTurn,
  voiceSay,
  type CallRef,
  type ClinicFacts,
  type Utterance,
  type VoiceInput,
  type VoiceLang,
} from "@dentalos/agent";
import type { JobQueue } from "@dentalos/core";
import { withAppRole, withClinic, type Pool } from "@dentalos/db";
import type { Logger } from "@dentalos/shared/logger";
import { Endpointer, SILENCE_MS } from "./audio/endpointer";
import { meteredLLM } from "./metered-llm";
import type { TtsCache } from "./tts-cache";

/**
 * One phone call on the media stream. The pipeline, all ours:
 *   caller audio → endpointer (voice activity + end of turn) → speech-to-text → dialogue turn (database,
 *   safety filter) → text-to-speech (cached for fixed phrases) → audio back to the caller.
 * Barge-in: if the caller starts talking over an interruptible reply, playback is cleared at once.
 * Turns are processed one at a time, in order.
 */
export interface VoiceDeps {
  pool: Pool;
  telephony: TelephonyProvider;
  speech: SpeechProvider;
  llm?: LLMProvider;
  jobs: JobQueue;
  logger: Logger;
  ttsCache: TtsCache;
  /** Silence after a question before the assistant checks the caller is there. */
  noInputMs: number;
  /** Say "one moment" if understanding takes longer than this. */
  fillerAfterMs: number;
  /** Hard stop for a single call. */
  maxCallMs: number;
  now?: () => Date;
}

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const FRAME_BYTES_PER_MS = 16; // 8 kHz × 2 bytes

export class CallSession {
  private streamId = "";
  private call: CallRef | null = null;
  private facts: ClinicFacts | null = null;
  private readonly endpointer: Endpointer;
  private queue: Promise<unknown> = Promise.resolve();
  private playing: { interruptible: boolean } | null = null;
  private readonly marks = new Map<string, () => void>();
  private markSeq = 0;
  private interrupted = false;
  private noInputTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private lang: VoiceLang = "hi";
  private finished = false;
  closing = false;
  readonly usage = { sttMs: 0, ttsChars: 0, llmInputTokens: 0, llmOutputTokens: 0, bargeIns: 0 };
  private readonly llm?: LLMProvider;

  constructor(
    private readonly socket: SocketLike,
    private readonly deps: VoiceDeps,
  ) {
    this.endpointer = new Endpointer({
      sampleRate: deps.telephony.stream.sampleRate,
      silenceMs: SILENCE_MS.open,
    });
    this.llm = deps.llm ? meteredLLM(deps.llm, this.usage) : undefined;
  }

  get callId() {
    return this.call?.callId ?? null;
  }

  private enqueue(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(fn).catch((error) => {
      this.deps.logger.error({ err: error, callId: this.callId }, "voice turn failed");
      // Something broke mid-call: hand the caller to the clinic rather than leaving them in silence.
      return this.failSafe();
    });
    return this.queue;
  }

  // ---------------------------------------------------------------- stream events

  onMessage(raw: string) {
    const event: StreamEvent = this.deps.telephony.stream.parse(raw);
    switch (event.type) {
      case "start":
        this.streamId = event.streamId;
        void this.enqueue(() => this.start(event));
        break;
      case "audio":
        this.audio(event.pcm);
        break;
      case "dtmf":
        this.clearNoInput();
        if (this.playing?.interruptible) this.bargeIn();
        void this.enqueue(() => this.turn({ kind: "dtmf", digit: event.digit }));
        break;
      case "mark":
        this.marks.get(event.name)?.();
        break;
      case "stop":
        void this.finish();
        break;
      default:
        break;
    }
  }

  onClose() {
    void this.finish();
  }

  private async start(event: Extract<StreamEvent, { type: "start" }>) {
    const provider = this.deps.telephony.name;
    const clinicId = await withAppRole(
      this.deps.pool,
      async (c) =>
        (await c.query("select app.clinic_for_call($1, $2) as id", [provider, event.providerCallId])).rows[0]
          .id as string | null,
    );
    let call: CallRef | null = null;
    if (clinicId) {
      const row = await withClinic(
        this.deps.pool,
        { clinicId, actor: "agent:voice", role: "agent" },
        async (c) =>
          (
            await c.query(
              "select id, from_phone, route from calls where provider = $1 and provider_call_id = $2",
              [provider, event.providerCallId],
            )
          ).rows[0],
      );
      if (row && row.route === "assistant") call = { clinicId, callId: row.id, phone: row.from_phone };
    } else {
      // The flow skipped the routing step: route here (the stream reaching us means we are healthy).
      const routed = await routeInboundCall(
        this.deps.pool,
        { provider, providerCallId: event.providerCallId, from: event.from, to: event.to },
        { voiceHealthy: true, now: this.now() },
      );
      if (routed?.route === "assistant")
        call = { clinicId: routed.clinicId, callId: routed.callId, phone: event.from };
    }
    if (!call) {
      this.deps.logger.warn({ provider }, "media stream for a call that is not ours to answer");
      this.hangup();
      return;
    }
    this.call = call;
    this.facts = await loadFacts(this.deps.pool, call.clinicId);
    this.lang = this.facts.defaultLanguage;
    this.maxTimer = setTimeout(() => void this.enqueue(async () => this.hangup()), this.deps.maxCallMs);
    await this.turn({ kind: "start" });
  }

  private audio(pcm: Uint8Array) {
    if (!this.call || this.closing) return;
    if (this.playing && !this.playing.interruptible) {
      // Notices and emergency scripts play in full; talk during them is not a turn.
      this.endpointer.reset();
      return;
    }
    for (const event of this.endpointer.push(pcm)) {
      if (event.type === "speech_start") {
        this.clearNoInput();
        if (this.playing?.interruptible) this.bargeIn();
      } else {
        const endedAt = Date.now();
        void this.enqueue(() => this.utterance(event.pcm, event.durationMs, endedAt));
      }
    }
  }

  private bargeIn() {
    this.usage.bargeIns++;
    this.interrupted = true;
    this.socket.send(this.deps.telephony.stream.clear(this.streamId));
    for (const resolve of this.marks.values()) resolve();
    this.marks.clear();
    this.playing = null;
  }

  // ---------------------------------------------------------------- turns

  private async utterance(pcm: Uint8Array, durationMs: number, endedAt: number) {
    if (!this.call || this.closing) return;
    this.usage.sttMs += durationMs;
    let filler = false;
    const fillerTimer = setTimeout(() => {
      filler = true;
      void this.speak([{ text: voiceSay(this.lang, "filler"), interruptible: true }]);
    }, this.deps.fillerAfterMs);
    let input: VoiceInput;
    try {
      const heard = await this.deps.speech.transcribe({
        format: "pcm16",
        audio: pcm,
        sampleRate: this.deps.telephony.stream.sampleRate,
        language: "auto",
      });
      input = heard.text
        ? { kind: "speech", text: heard.text, language: heard.language }
        : { kind: "unclear" };
    } catch (error) {
      this.deps.logger.warn({ err: error, callId: this.callId }, "speech-to-text failed");
      input = { kind: "unclear" };
    }
    await this.turn(input, { endedAt, fillerTimer, filler: () => filler });
  }

  private async turn(
    input: VoiceInput,
    timing?: { endedAt: number; fillerTimer: NodeJS.Timeout; filler: () => boolean },
  ) {
    if (!this.call || !this.facts || this.closing) {
      if (timing) clearTimeout(timing.fillerTimer);
      return;
    }
    const result = await runVoiceTurn(this.deps.pool, this.call, this.facts, input, {
      llm: this.llm,
      now: () => this.now(),
    });
    if (timing) clearTimeout(timing.fillerTimer);
    this.lang = result.state.lang;
    this.endpointer.setSilenceMs(SILENCE_MS[result.expect]);
    const clinicId = this.call.clinicId;
    if (result.planMessages)
      await this.deps.jobs.add("plan_messages", { clinicId }, { jobKey: `plan:${clinicId}` });
    if (result.emergency) await this.deps.jobs.add("outbox_sweep", {}, { jobKey: "outbox_sweep:now" });

    const call = this.call;
    await this.speak(result.say, () => {
      if (timing && result.assistantTurnId)
        void recordLatency(this.deps.pool, call, result.assistantTurnId, Date.now() - timing.endedAt).catch(
          () => {},
        );
    });
    if (result.end) {
      this.hangup();
      return;
    }
    this.armNoInput();
  }

  /** Synthesises every sentence at once and plays them in order as they become ready. */
  private async speak(utterances: Utterance[], onFirstAudio?: () => void) {
    this.interrupted = false;
    const language = this.lang === "hi" ? "hi-IN" : "en-IN";
    const sampleRate = this.deps.telephony.stream.sampleRate;
    const audio = utterances.map((u) =>
      this.deps.ttsCache.get(this.deps.speech, u.text, language, sampleRate).then((r) => {
        this.usage.ttsChars += r.billedChars;
        return r.pcm;
      }),
    );
    // Avoid unhandled rejections for sentences we never get to.
    for (const a of audio) a.catch(() => {});
    let first = true;
    for (const [i, u] of utterances.entries()) {
      if (this.interrupted || this.closing) break;
      const pcm = await audio[i]!;
      if (this.interrupted || this.closing) break;
      if (first) {
        first = false;
        onFirstAudio?.();
      }
      await this.play(pcm, u.interruptible);
    }
  }

  private async play(pcm: Uint8Array, interruptible: boolean) {
    const codec = this.deps.telephony.stream;
    for (const frame of codec.audio(this.streamId, pcm)) this.socket.send(frame);
    const name = `m${++this.markSeq}`;
    this.playing = { interruptible };
    const done = new Promise<void>((resolve) => this.marks.set(name, resolve));
    this.socket.send(codec.mark(this.streamId, name));
    // If the provider never confirms playback, carry on after the audio's own length.
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, pcm.byteLength / FRAME_BYTES_PER_MS + 3000).unref(),
    );
    await Promise.race([done, timeout]);
    this.marks.delete(name);
    if (this.playing?.interruptible === interruptible) this.playing = null;
  }

  private armNoInput() {
    this.clearNoInput();
    this.noInputTimer = setTimeout(() => {
      this.noInputTimer = null;
      if (!this.endpointer.speaking) void this.enqueue(() => this.turn({ kind: "no_input" }));
    }, this.deps.noInputMs);
  }

  private clearNoInput() {
    if (this.noInputTimer) clearTimeout(this.noInputTimer);
    this.noInputTimer = null;
  }

  /** Ends our part of the call. The provider's flow then connects a transfer or hangs up. */
  private hangup() {
    if (this.closing) return;
    this.closing = true;
    this.clearNoInput();
    this.socket.close(1000, "done");
    void this.finish();
  }

  private async failSafe() {
    if (!this.call || this.closing) return this.hangup();
    try {
      await withClinic(
        this.deps.pool,
        { clinicId: this.call.clinicId, actor: "agent:voice", role: "agent" },
        async (c) => {
          const clinic = (await c.query("select phone from clinics where id = app.current_clinic_id()"))
            .rows[0];
          if (clinic?.phone)
            await c.query(
              "update calls set transfer_kind = 'staff', transfer_numbers = $2, status = 'transferring', outcome = 'error' where id = $1",
              [this.call!.callId, [clinic.phone]],
            );
        },
      );
    } finally {
      this.hangup();
    }
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    this.closing = true;
    this.clearNoInput();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    for (const resolve of this.marks.values()) resolve();
    this.marks.clear();
    if (!this.call) return;
    await this.queue.catch(() => {});
    await endCall(this.deps.pool, this.call, this.usage).catch((error) =>
      this.deps.logger.error({ err: error, callId: this.callId }, "could not close call record"),
    );
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }
}

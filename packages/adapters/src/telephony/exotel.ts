import { normalizePhone } from "@dentalos/shared";
import { chunk } from "../audio";
import { ProviderError, safeEqualHex, type HealthStatus } from "../common";
import type {
  CallStatusEvent,
  FlowDecision,
  FlowHttpRequest,
  FlowHttpResponse,
  MediaStreamCodec,
  StreamEvent,
  TelephonyProvider,
} from "./types";

/**
 * Exotel (India). The clinic's call flow (built once in the Exotel dashboard, see docs/SETUP.md) uses:
 * - Passthru applets that call our URLs; answering 200 takes one branch, 302 the other;
 * - a Voicebot applet that streams the call audio to our voice service (bidirectional, 8 kHz PCM16);
 * - a Connect applet with a dynamic URL that asks us which numbers to ring.
 * Exotel does not sign these requests, so every URL carries a secret token (`key=`), checked here.
 * Docs: https://developer.exotel.com (Voicebot, Passthru, Connect applets).
 */
export interface ExotelConfig {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  /** "api.exotel.com" (Singapore) or "api.in.exotel.com" (Mumbai). */
  apiHost?: string;
  /** Secret included as `key=` in every URL configured in the Exotel flow. */
  callbackToken: string;
  fetchImpl?: typeof fetch;
}

/** The fields we read from Exotel's stream messages. */
interface ExotelMessage {
  event?: string;
  stream_sid?: string;
  start?: {
    stream_sid?: string;
    call_sid?: string;
    from?: string;
    to?: string;
    custom_parameters?: Record<string, string>;
    media_format?: { sample_rate?: string | number };
  };
  media?: { payload?: string };
  dtmf?: { digit?: string };
  mark?: { name?: string };
  stop?: { reason?: string };
}

/** Exotel wants media chunks in multiples of 320 bytes; 3,200 bytes = 200 ms at 8 kHz. */
const CHUNK_BYTES = 3200;

export const exotelStreamCodec: MediaStreamCodec = {
  sampleRate: 8000,
  parse(message: string): StreamEvent {
    let m: ExotelMessage;
    try {
      m = JSON.parse(message) as ExotelMessage;
    } catch {
      return { type: "unknown" };
    }
    switch (m.event) {
      case "connected":
        return { type: "connected" };
      case "start": {
        const s = m.start ?? {};
        return {
          type: "start",
          streamId: String(m.stream_sid ?? s.stream_sid ?? ""),
          providerCallId: String(s.call_sid ?? ""),
          from: phoneOrNull(s.from),
          to: phoneOrNull(s.to),
          sampleRate: Number(s.media_format?.sample_rate ?? 8000) || 8000,
          params: (s.custom_parameters ?? {}) as Record<string, string>,
        };
      }
      case "media":
        return { type: "audio", pcm: new Uint8Array(Buffer.from(String(m.media?.payload ?? ""), "base64")) };
      case "dtmf":
        return { type: "dtmf", digit: String(m.dtmf?.digit ?? "") };
      case "mark":
        return { type: "mark", name: String(m.mark?.name ?? "") };
      case "stop":
        return { type: "stop", reason: m.stop?.reason ?? null };
      default:
        return { type: "unknown" };
    }
  },
  audio(streamId, pcm) {
    return chunk(pcm, CHUNK_BYTES).map((c) =>
      JSON.stringify({
        event: "media",
        stream_sid: streamId,
        media: { payload: Buffer.from(c).toString("base64") },
      }),
    );
  },
  mark(streamId, name) {
    return JSON.stringify({ event: "mark", stream_sid: streamId, mark: { name } });
  },
  clear(streamId) {
    return JSON.stringify({ event: "clear", stream_sid: streamId });
  },
};

function phoneOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return normalizePhone(value) ?? null;
}

export class ExotelProvider implements TelephonyProvider {
  readonly name = "exotel";
  readonly stream = exotelStreamCodec;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: ExotelConfig) {
    this.fetch = config.fetchImpl ?? fetch;
  }

  verifyFlowRequest(request: FlowHttpRequest): boolean {
    const key = request.params.key ?? "";
    return !!key && safeEqualHex(key, this.config.callbackToken);
  }

  parseFlowRequest(request: FlowHttpRequest) {
    const p = request.params;
    return {
      providerCallId: p.CallSid ?? "",
      from: phoneOrNull(p.CallFrom ?? p.From),
      to: phoneOrNull(p.CallTo ?? p.To),
      dialStatus: p.DialCallStatus ?? null,
      digits: p.digits ? p.digits.replace(/"/g, "") : (p.Digits ?? null),
    };
  }

  flowResponse(decision: FlowDecision): FlowHttpResponse {
    if (decision.kind === "branch")
      return decision.yes
        ? { status: 200, contentType: "text/plain", body: "OK" }
        : { status: 302, contentType: "text/plain", body: "NO" };
    const national = (n: string) => n.replace(/^\+91/, "0");
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fetch_after_attempt: false,
        destination: { numbers: decision.numbers.map(national) },
        ...(decision.callerId ? { outgoing_phone_number: national(decision.callerId) } : {}),
        record: decision.record,
        recording_channels: "dual",
        max_ringing_duration: decision.ringSeconds,
        max_conversation_duration: 3600,
        ...(decision.whisper ? { start_call_playback: { type: "text", value: decision.whisper } } : {}),
      }),
    };
  }

  parseStatusCallback(request: FlowHttpRequest): CallStatusEvent | null {
    const p = request.params;
    if (!p.CallSid || !p.Status) return null;
    const statuses: Record<string, CallStatusEvent["status"]> = {
      completed: "completed",
      "no-answer": "no_answer",
      busy: "busy",
      failed: "failed",
      canceled: "canceled",
    };
    const status = statuses[p.Status.toLowerCase()];
    if (!status) return null;
    const duration = Number(p.ConversationDuration ?? p.Duration ?? p.DialCallDuration);
    return {
      providerCallId: p.CallSid,
      status,
      durationSec: Number.isFinite(duration) ? duration : null,
      recordingUrl: p.RecordingUrl || null,
      at: p.EndTime ? new Date(`${p.EndTime.replace(" ", "T")}+05:30`) : new Date(),
    };
  }

  private auth() {
    return `Basic ${Buffer.from(`${this.config.apiKey}:${this.config.apiToken}`).toString("base64")}`;
  }

  async placeCall(input: { to: string; callerId: string; flowId: string; clientRef?: string }) {
    const host = this.config.apiHost ?? "api.exotel.com";
    const body = new URLSearchParams({
      From: input.to.replace(/^\+91/, "0"),
      CallerId: input.callerId.replace(/^\+91/, "0"),
      Url: `http://my.exotel.com/${this.config.accountSid}/exoml/start_voice/${input.flowId}`,
      ...(input.clientRef ? { CustomField: input.clientRef } : {}),
    });
    let res: Response;
    try {
      res = await this.fetch(`https://${host}/v1/Accounts/${this.config.accountSid}/Calls/connect.json`, {
        method: "POST",
        headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, "network", `Exotel unreachable: ${(error as Error).name}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as { Call?: { Sid?: string } };
    if (!res.ok || !json.Call?.Sid)
      throw new ProviderError(
        this.name,
        String(res.status),
        `Exotel error ${res.status}`,
        res.status >= 500 || res.status === 429,
      );
    return { providerCallId: json.Call.Sid };
  }

  async fetchRecording(url: string) {
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { authorization: this.auth() },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ProviderError(
        this.name,
        "network",
        `Recording download failed: ${(error as Error).name}`,
        true,
      );
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new ProviderError(this.name, String(res.status), "Recording download failed", res.status >= 500);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg",
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    return this.config.accountSid && this.config.apiKey && this.config.apiToken
      ? { ok: true }
      : { ok: false, detail: "Exotel credentials missing" };
  }
}

import type { ProviderBase } from "../common";

/**
 * Indian telephony (Exotel; Plivo later). The provider carries the call and streams its audio to our voice
 * service over a WebSocket; every decision (answer with the assistant, forward to the clinic, transfer to a
 * doctor) is ours, made when the provider's call flow asks our HTTP endpoints.
 */
export interface TelephonyProvider extends ProviderBase {
  /** Reads and writes the provider's bidirectional media-stream messages. */
  readonly stream: MediaStreamCodec;
  /** Checks that a request from the provider's call flow is really from our account (shared token). */
  verifyFlowRequest(request: FlowHttpRequest): boolean;
  /** The call and numbers named in a call-flow request. */
  parseFlowRequest(request: FlowHttpRequest): FlowRequest;
  /** How to answer a call-flow request. */
  flowResponse(decision: FlowDecision): FlowHttpResponse;
  /** A call status callback (end of call, recording available), or null if it is not one. */
  parseStatusCallback(request: FlowHttpRequest): CallStatusEvent | null;
  /** Outbound call that runs our call flow (Phase 4 confirmations and follow-ups). */
  placeCall(input: { to: string; callerId: string; flowId: string; clientRef?: string }): Promise<{
    providerCallId: string;
  }>;
  fetchRecording(url: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export interface FlowHttpRequest {
  /** Query string and form fields, merged. */
  params: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
}

export interface FlowRequest {
  providerCallId: string;
  from: string | null;
  to: string | null;
  /** Result of the previous dial step, when the flow reports it ("completed", "no-answer", "busy"…). */
  dialStatus: string | null;
  digits: string | null;
}

export type FlowDecision =
  /** Branch point: `yes` takes the flow's first branch (e.g. "answer with the assistant"). */
  | { kind: "branch"; yes: boolean }
  /** Ring these numbers in order; the first to answer is connected. */
  | {
      kind: "connect";
      numbers: string[];
      callerId?: string;
      ringSeconds: number;
      record: boolean;
      /** Spoken to the person who picks up before connecting (e.g. "Emergency call from a patient"). */
      whisper?: string;
    };

export interface FlowHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface CallStatusEvent {
  providerCallId: string;
  status: "completed" | "no_answer" | "busy" | "failed" | "canceled";
  durationSec: number | null;
  recordingUrl: string | null;
  at: Date;
}

/** Media-stream protocol: the provider's JSON messages in, ours out. Audio is PCM16 mono. */
export interface MediaStreamCodec {
  readonly sampleRate: number;
  parse(message: string): StreamEvent;
  /** Frames that play `pcm` to the caller (already split into acceptable chunk sizes). */
  audio(streamId: string, pcm: Uint8Array): string[];
  /** Asks the provider to report back when everything queued before it has been played. */
  mark(streamId: string, name: string): string;
  /** Stops playback immediately (barge-in). */
  clear(streamId: string): string;
}

export type StreamEvent =
  | { type: "connected" }
  | {
      type: "start";
      streamId: string;
      providerCallId: string;
      from: string | null;
      to: string | null;
      sampleRate: number;
      params: Record<string, string>;
    }
  | { type: "audio"; pcm: Uint8Array }
  | { type: "dtmf"; digit: string }
  | { type: "mark"; name: string }
  | { type: "stop"; reason: string | null }
  | { type: "unknown" };

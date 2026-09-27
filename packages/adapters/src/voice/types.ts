import type { ProviderBase, UsageReport, WebhookReceiver } from "../common.js";

/**
 * The conversational voice layer (Sarvam in production). See PLAN decision D4: the adapter declares which
 * safety hooks it supports so the call flow can refuse to go live without the required ones.
 */
export interface VoiceProvider extends ProviderBase, WebhookReceiver<VoiceEvent> {
  readonly capabilities: VoiceCapabilities;
  startSession(input: {
    providerCallId: string;
    language: string;
    /** System prompt generated from clinic configuration; never contains other patients' data. */
    systemPrompt: string;
    greeting: string;
    /** Our Tool API base URL; the provider signs every tool request. */
    toolEndpoint: string;
    clientRef?: string;
  }): Promise<{ sessionId: string; sipUri: string }>;
  /** Forces the next thing the agent says (used for emergency scripts and safety-filter replacements). */
  say(sessionId: string, text: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  /** Speech-to-text for WhatsApp voice notes. */
  transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    languageHint?: string;
  }): Promise<{ text: string; language: string }>;
}

export interface VoiceCapabilities {
  toolWebhooks: boolean;
  transcriptStream: boolean;
  /** Can we inspect and replace an agent utterance before it is spoken? Required by the safety filter. */
  responseInterception: boolean;
  languages: string[];
}

export type VoiceEvent =
  | {
      type: "turn";
      eventId: string;
      sessionId: string;
      speaker: "caller" | "agent";
      text: string;
      language?: string;
      at: Date;
    }
  | { type: "ended"; eventId: string; sessionId: string; reason: string; at: Date; usage?: UsageReport };

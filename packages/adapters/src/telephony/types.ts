import type { ProviderBase, UsageReport, WebhookReceiver } from "../common";

/** Indian telephony (Exotel / Plivo): virtual numbers, forwarding, recording, warm transfer, outbound calls. */
export interface TelephonyProvider extends ProviderBase, WebhookReceiver<TelephonyEvent> {
  placeCall(input: {
    from: string;
    to: string;
    /** Where the answered call is connected: the voice agent (SIP URI) or a plain bridge to a phone. */
    connectTo: { kind: "voice_agent"; sipUri: string } | { kind: "phone"; number: string };
    record: boolean;
    clientRef?: string;
  }): Promise<{ providerCallId: string }>;
  /** Warm transfer: rings `to`; the caller is only moved across if the human answers within `ringTimeoutSec`. */
  transferCall(input: {
    providerCallId: string;
    to: string;
    ringTimeoutSec: number;
  }): Promise<{ answered: boolean }>;
  hangup(providerCallId: string): Promise<void>;
  fetchRecording(providerCallId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export type TelephonyEvent =
  | { type: "incoming"; eventId: string; providerCallId: string; from: string; to: string; at: Date }
  | { type: "missed"; eventId: string; providerCallId: string; from: string; to: string; at: Date }
  | {
      type: "completed";
      eventId: string;
      providerCallId: string;
      durationSec: number;
      at: Date;
      usage?: UsageReport;
    }
  | { type: "recording_ready"; eventId: string; providerCallId: string; at: Date };

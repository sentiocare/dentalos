import type { ProviderBase, UsageReport, WebhookReceiver } from "../common";

/**
 * A clinic's WhatsApp Business number. Each clinic has its own number and access token; the provider app
 * (and so the webhook secret) is Sentio's and shared.
 */
export interface MessagingChannel {
  /** Meta's phone_number_id. */
  channelId: string;
  accessToken: string;
}

/**
 * WhatsApp-style messaging (WhatsApp Cloud API in production).
 * Adapters do not deduplicate sends: the outbox guarantees each message is handed over once.
 */
export interface MessagingProvider extends ProviderBase, WebhookReceiver<MessagingEvent> {
  sendText(channel: MessagingChannel, input: { to: string; text: string }): Promise<SendResult>;
  sendTemplate(
    channel: MessagingChannel,
    input: {
      to: string;
      templateName: string;
      language: string;
      bodyParams: string[];
      /** Payloads for quick-reply buttons defined in the approved template, in order. */
      buttonPayloads?: string[];
    },
  ): Promise<SendResult>;
  /** Up to 3 reply buttons (WhatsApp limit), used for slot selection and Confirm/Reschedule. */
  sendButtons(
    channel: MessagingChannel,
    input: { to: string; body: string; buttons: { id: string; title: string }[] },
  ): Promise<SendResult>;
  sendDocument(
    channel: MessagingChannel,
    input: {
      to: string;
      /** Short-lived signed URL of the PDF. */
      url: string;
      filename: string;
      caption?: string;
    },
  ): Promise<SendResult>;
  downloadMedia(channel: MessagingChannel, mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Answers the provider's webhook subscription check; returns the challenge to echo, or null. */
  verifySubscription?(query: Record<string, string | undefined>): string | null;
}

export interface SendResult {
  providerMessageId: string;
}

export type MessagingEvent =
  | {
      type: "inbound_message";
      eventId: string;
      providerMessageId: string;
      /** The patient's number, E.164. */
      from: string;
      /** The name the patient set in WhatsApp, if shared. */
      profileName?: string;
      /** Which clinic number received it (Meta phone_number_id); maps to exactly one clinic. */
      channelId: string;
      at: Date;
      content:
        | { kind: "text"; text: string }
        | { kind: "button_reply"; payload: string; title: string }
        | { kind: "audio"; mediaId: string; mimeType: string }
        | { kind: "image" | "document"; mediaId: string; mimeType: string; caption?: string }
        | { kind: "unsupported" };
    }
  | {
      type: "status";
      eventId: string;
      channelId: string;
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      at: Date;
      errorCode?: string;
      usage?: UsageReport & { category?: "utility" | "marketing" | "authentication" | "service" };
    };

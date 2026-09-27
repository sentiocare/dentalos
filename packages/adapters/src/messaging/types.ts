import type { ProviderBase, UsageReport, WebhookReceiver } from "../common.js";

/**
 * WhatsApp-style messaging (WhatsApp Cloud API in production).
 * Adapters do not deduplicate sends: the outbox guarantees each message is handed over once.
 */
export interface MessagingProvider extends ProviderBase, WebhookReceiver<MessagingEvent> {
  sendText(input: { to: string; text: string; clientRef?: string }): Promise<SendResult>;
  sendTemplate(input: {
    to: string;
    templateName: string;
    language: string;
    bodyParams: string[];
    /** Payloads for quick-reply buttons defined in the approved template, in order. */
    buttonPayloads?: string[];
    clientRef?: string;
  }): Promise<SendResult>;
  /** Up to 3 reply buttons (WhatsApp limit), used for slot selection and Confirm/Reschedule. */
  sendButtons(input: {
    to: string;
    body: string;
    buttons: { id: string; title: string }[];
    clientRef?: string;
  }): Promise<SendResult>;
  sendDocument(input: {
    to: string;
    /** Short-lived signed URL of the PDF. */
    url: string;
    filename: string;
    caption?: string;
    clientRef?: string;
  }): Promise<SendResult>;
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface SendResult {
  providerMessageId: string;
}

export type MessagingEvent =
  | {
      type: "inbound_message";
      eventId: string;
      providerMessageId: string;
      from: string;
      /** The business number that received it; maps to a clinic. */
      to: string;
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
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      at: Date;
      errorCode?: string;
      usage?: UsageReport & { category?: "utility" | "marketing" | "authentication" | "service" };
    };

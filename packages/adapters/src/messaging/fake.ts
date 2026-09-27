import type { RawWebhook } from "../common";
import { FakeSupport, fakeId } from "../fake-support";
import type { MessagingChannel, MessagingEvent, MessagingProvider, SendResult } from "./types";

type SentContent =
  | { kind: "text"; to: string; text: string }
  | {
      kind: "template";
      to: string;
      templateName: string;
      language: string;
      bodyParams: string[];
      buttonPayloads?: string[];
    }
  | { kind: "buttons"; to: string; body: string; buttons: { id: string; title: string }[] }
  | { kind: "document"; to: string; url: string; filename: string; caption?: string };

export type FakeSentMessage = SentContent & { providerMessageId: string; channelId: string };

export class FakeMessagingProvider implements MessagingProvider {
  readonly name = "fake-messaging";
  readonly support: FakeSupport;
  readonly sent: FakeSentMessage[] = [];
  readonly media = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  constructor(webhookSecret = "fake-messaging-secret") {
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  private record(channel: MessagingChannel, message: SentContent): SendResult {
    this.support.throwIfScripted();
    if (!channel.accessToken) throw new Error("missing access token");
    const providerMessageId = fakeId("wamid");
    this.sent.push({ ...message, providerMessageId, channelId: channel.channelId });
    return { providerMessageId };
  }

  /** Messages sent to one number, oldest first (test helper). */
  to(phone: string): FakeSentMessage[] {
    return this.sent.filter((m) => m.to === phone);
  }

  async sendText(channel: MessagingChannel, input: { to: string; text: string }) {
    return this.record(channel, { kind: "text", to: input.to, text: input.text });
  }

  async sendTemplate(
    channel: MessagingChannel,
    input: {
      to: string;
      templateName: string;
      language: string;
      bodyParams: string[];
      buttonPayloads?: string[];
    },
  ) {
    return this.record(channel, { kind: "template", ...input });
  }

  async sendButtons(
    channel: MessagingChannel,
    input: { to: string; body: string; buttons: { id: string; title: string }[] },
  ) {
    if (input.buttons.length < 1 || input.buttons.length > 3) {
      throw new RangeError("WhatsApp allows 1 to 3 reply buttons");
    }
    if (input.buttons.some((b) => b.title.length > 20)) {
      throw new RangeError("WhatsApp button titles are limited to 20 characters");
    }
    return this.record(channel, { kind: "buttons", to: input.to, body: input.body, buttons: input.buttons });
  }

  async sendDocument(
    channel: MessagingChannel,
    input: { to: string; url: string; filename: string; caption?: string },
  ) {
    return this.record(channel, { kind: "document", ...input });
  }

  async downloadMedia(_channel: MessagingChannel, mediaId: string) {
    this.support.throwIfScripted();
    const media = this.media.get(mediaId);
    if (!media) throw new Error(`Unknown media ${mediaId}`);
    return media;
  }

  verifySubscription(query: Record<string, string | undefined>) {
    return query["hub.mode"] === "subscribe" && query["hub.verify_token"] === "fake-verify"
      ? (query["hub.challenge"] ?? null)
      : null;
  }

  healthCheck() {
    return this.support.healthCheck();
  }

  verifyWebhook(webhook: RawWebhook) {
    return this.support.verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook) {
    return this.support.parseWebhook<MessagingEvent>(webhook);
  }

  /** Builds a correctly signed inbound webhook, as WhatsApp would deliver it. */
  inboundWebhook(events: MessagingEvent[]): RawWebhook {
    return this.support.signWebhook(events);
  }
}

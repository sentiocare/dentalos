import type { RawWebhook } from "../common";
import { FakeSupport, fakeId } from "../fake-support";
import type { MessagingEvent, MessagingProvider, SendResult } from "./types";

type SentContent =
  | { kind: "text"; to: string; text: string }
  | { kind: "template"; to: string; templateName: string; language: string; bodyParams: string[] }
  | { kind: "buttons"; to: string; body: string; buttons: { id: string; title: string }[] }
  | { kind: "document"; to: string; url: string; filename: string; caption?: string };

export type FakeSentMessage = SentContent & { providerMessageId: string };

export class FakeMessagingProvider implements MessagingProvider {
  readonly name = "fake-messaging";
  readonly support: FakeSupport;
  readonly sent: FakeSentMessage[] = [];
  readonly media = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  constructor(webhookSecret = "fake-messaging-secret") {
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  private record(message: SentContent): SendResult {
    this.support.throwIfScripted();
    const providerMessageId = fakeId("wamid");
    this.sent.push({ ...message, providerMessageId });
    return { providerMessageId };
  }

  async sendText(input: { to: string; text: string }) {
    return this.record({ kind: "text", to: input.to, text: input.text });
  }

  async sendTemplate(input: { to: string; templateName: string; language: string; bodyParams: string[] }) {
    return this.record({
      kind: "template",
      to: input.to,
      templateName: input.templateName,
      language: input.language,
      bodyParams: input.bodyParams,
    });
  }

  async sendButtons(input: { to: string; body: string; buttons: { id: string; title: string }[] }) {
    if (input.buttons.length < 1 || input.buttons.length > 3) {
      throw new RangeError("WhatsApp allows 1 to 3 reply buttons");
    }
    if (input.buttons.some((b) => b.title.length > 20)) {
      throw new RangeError("WhatsApp button titles are limited to 20 characters");
    }
    return this.record({ kind: "buttons", to: input.to, body: input.body, buttons: input.buttons });
  }

  async sendDocument(input: { to: string; url: string; filename: string; caption?: string }) {
    return this.record({ kind: "document", ...input });
  }

  async downloadMedia(mediaId: string) {
    this.support.throwIfScripted();
    const media = this.media.get(mediaId);
    if (!media) throw new Error(`Unknown media ${mediaId}`);
    return media;
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

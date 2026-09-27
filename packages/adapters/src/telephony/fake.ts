import type { RawWebhook } from "../common.js";
import { FakeSupport, fakeId } from "../fake-support.js";
import type { TelephonyEvent, TelephonyProvider } from "./types.js";

export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name = "fake-telephony";
  readonly support: FakeSupport;
  readonly placedCalls: { providerCallId: string; from: string; to: string; record: boolean }[] = [];
  readonly transfers: { providerCallId: string; to: string; answered: boolean }[] = [];
  readonly hungUp: string[] = [];
  /** Numbers that will answer a warm transfer. Everyone else lets it ring out. */
  readonly answeringNumbers = new Set<string>();
  readonly recordings = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  constructor(webhookSecret = "fake-telephony-secret") {
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  async placeCall(input: { from: string; to: string; record: boolean }) {
    this.support.throwIfScripted();
    const providerCallId = fakeId("call");
    this.placedCalls.push({ providerCallId, from: input.from, to: input.to, record: input.record });
    return { providerCallId };
  }

  async transferCall(input: { providerCallId: string; to: string }) {
    this.support.throwIfScripted();
    const answered = this.answeringNumbers.has(input.to);
    this.transfers.push({ providerCallId: input.providerCallId, to: input.to, answered });
    return { answered };
  }

  async hangup(providerCallId: string) {
    this.support.throwIfScripted();
    this.hungUp.push(providerCallId);
  }

  async fetchRecording(providerCallId: string) {
    this.support.throwIfScripted();
    return this.recordings.get(providerCallId) ?? null;
  }

  healthCheck() {
    return this.support.healthCheck();
  }

  verifyWebhook(webhook: RawWebhook) {
    return this.support.verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook) {
    return this.support.parseWebhook<TelephonyEvent>(webhook);
  }

  eventWebhook(events: TelephonyEvent[]): RawWebhook {
    return this.support.signWebhook(events);
  }
}

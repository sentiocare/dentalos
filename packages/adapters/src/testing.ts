/**
 * Contract test suites. Every adapter (fake or real) must pass the suite for its provider type, so a new
 * provider can be swapped in with confidence. Real adapters run these against recorded fixtures in CI and
 * against the provider sandbox in the live smoke suite.
 */
import { describe, expect, it } from "vitest";
import type { RawWebhook } from "./common";
import type { MessagingChannel, MessagingEvent, MessagingProvider } from "./messaging/types";
import type { PaymentEvent, PaymentProvider } from "./payments/types";
import type { StorageProvider } from "./storage/types";
import type { TelephonyProvider } from "./telephony/types";
import type { SpeechProvider } from "./voice/types";

function tamper(webhook: RawWebhook): RawWebhook {
  return { ...webhook, rawBody: webhook.rawBody.replace(/.$/, " }") };
}

function expectStableEventIds(events: { eventId: string }[]) {
  for (const event of events) {
    expect(event.eventId, "every webhook event needs an id for idempotent processing").toMatch(/\S/);
  }
}

export function messagingContract(
  label: string,
  setup: () => {
    provider: MessagingProvider;
    signedWebhook: (events: MessagingEvent[]) => RawWebhook;
  },
  // Contract runs against real adapters use a mocked HTTP layer; nothing leaves the machine.
) {
  describe(`MessagingProvider contract: ${label}`, () => {
    const inbound: MessagingEvent = {
      type: "inbound_message",
      eventId: "evt-1",
      providerMessageId: "m-1",
      from: "+919876543210",
      channelId: "1234567890",
      at: new Date("2026-10-01T04:30:00Z"),
      content: { kind: "text", text: "RCT kitna ka hai?" },
    };
    const channel: MessagingChannel = { channelId: "1234567890", accessToken: "token" };

    it("accepts a correctly signed webhook and normalises events", () => {
      const { provider, signedWebhook } = setup();
      const webhook = signedWebhook([inbound]);
      expect(provider.verifyWebhook(webhook)).toBe(true);
      const events = provider.parseWebhook(webhook);
      // Event ids are provider-specific; they only need to exist and be stable.
      const { eventId: _id, ...expected } = inbound;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject(expected);
      expectStableEventIds(events);
    });

    it("rejects tampered or unsigned webhooks", () => {
      const { provider, signedWebhook } = setup();
      const webhook = signedWebhook([inbound]);
      expect(provider.verifyWebhook(tamper(webhook))).toBe(false);
      expect(provider.verifyWebhook({ headers: {}, rawBody: webhook.rawBody })).toBe(false);
      expect(() => provider.parseWebhook(tamper(webhook))).toThrow();
    });

    it("returns a provider message id for every send", async () => {
      const { provider } = setup();
      const results = await Promise.all([
        provider.sendText(channel, { to: "+919876543210", text: "Namaste" }),
        provider.sendTemplate(channel, {
          to: "+919876543210",
          templateName: "appointment_reminder",
          language: "hi",
          bodyParams: ["Ramesh ji", "kal shaam 5 baje"],
        }),
        provider.sendButtons(channel, {
          to: "+919876543210",
          body: "Kaunsa samay theek rahega?",
          buttons: [
            { id: "slot_1", title: "Mangal 5 PM" },
            { id: "slot_2", title: "Budh 11 AM" },
          ],
        }),
      ]);
      for (const r of results) expect(r.providerMessageId).toMatch(/\S/);
      expect(new Set(results.map((r) => r.providerMessageId)).size).toBe(3);
    });

    it("refuses more than 3 reply buttons", async () => {
      const { provider } = setup();
      const buttons = ["a", "b", "c", "d"].map((id) => ({ id, title: id }));
      await expect(
        provider.sendButtons(channel, { to: "+919876543210", body: "x", buttons }),
      ).rejects.toThrow();
    });

    it("reports health", async () => {
      const { provider } = setup();
      expect(typeof (await provider.healthCheck()).ok).toBe("boolean");
    });
  });
}

export function telephonyContract(
  label: string,
  setup: () => { provider: TelephonyProvider; callbackToken: string },
) {
  describe(`TelephonyProvider contract: ${label}`, () => {
    it("accepts call-flow requests only with the secret token", () => {
      const { provider, callbackToken } = setup();
      expect(provider.verifyFlowRequest({ params: { key: callbackToken }, headers: {} })).toBe(true);
      expect(provider.verifyFlowRequest({ params: { key: "wrong" }, headers: {} })).toBe(false);
      expect(provider.verifyFlowRequest({ params: {}, headers: {} })).toBe(false);
    });

    it("reads calls from call-flow requests and answers branch and connect decisions", () => {
      const { provider } = setup();
      const req = provider.parseFlowRequest({
        params: {
          CallSid: "c1",
          CallFrom: "09876543210",
          CallTo: "08047112233",
          DialCallStatus: "no-answer",
        },
        headers: {},
      });
      expect(req).toMatchObject({ providerCallId: "c1", from: "+919876543210", dialStatus: "no-answer" });
      expect(provider.flowResponse({ kind: "branch", yes: true }).status).toBe(200);
      expect(provider.flowResponse({ kind: "branch", yes: false }).status).not.toBe(200);
      const connect = provider.flowResponse({
        kind: "connect",
        numbers: ["+919811111111", "+919822222222"],
        ringSeconds: 20,
        record: true,
      });
      expect(connect.status).toBe(200);
      expect(connect.body).toContain("9811111111");
      expect(connect.body.indexOf("9811111111")).toBeLessThan(connect.body.indexOf("9822222222"));
    });

    it("round-trips media-stream audio, marks and clear", () => {
      const { provider } = setup();
      const codec = provider.stream;
      const pcm = new Uint8Array(5000).map((_, i) => i % 256);
      const frames = codec.audio("s1", pcm);
      const back = frames.map((f) => codec.parse(f.replace('"event":"media"', '"event":"media"')));
      const joined = Buffer.concat(
        back.map((e) => (e.type === "audio" ? Buffer.from(e.pcm) : Buffer.alloc(0))),
      );
      expect(joined.subarray(0, pcm.length).equals(Buffer.from(pcm))).toBe(true);
      expect(codec.parse(codec.mark("s1", "m1"))).toEqual({ type: "mark", name: "m1" });
      expect(JSON.parse(codec.clear("s1"))).toMatchObject({ event: "clear" });
    });

    it("parses call status callbacks", () => {
      const { provider } = setup();
      const e = provider.parseStatusCallback({
        params: {
          CallSid: "c1",
          Status: "completed",
          ConversationDuration: "95",
          RecordingUrl: "https://r/1.mp3",
        },
        headers: {},
      });
      expect(e).toMatchObject({
        providerCallId: "c1",
        status: "completed",
        durationSec: 95,
        recordingUrl: "https://r/1.mp3",
      });
      expect(provider.parseStatusCallback({ params: { foo: "bar" }, headers: {} })).toBeNull();
    });
  });
}

export function speechContract(label: string, setup: () => { provider: SpeechProvider }) {
  describe(`SpeechProvider contract: ${label}`, () => {
    it("synthesises PCM at the requested sample rate and transcribes it", async () => {
      const { provider } = setup();
      const speech = await provider.synthesize({ text: "कल शाम 5 बजे", language: "hi-IN", sampleRate: 8000 });
      expect(speech.sampleRate).toBe(8000);
      expect(speech.pcm.byteLength % 2).toBe(0);
      expect(speech.pcm.byteLength).toBeGreaterThan(1000);
      expect(speech.characters).toBeGreaterThan(0);
      const heard = await provider.transcribe({
        format: "pcm16",
        audio: speech.pcm,
        sampleRate: 8000,
        language: "auto",
      });
      expect(typeof heard.text).toBe("string");
      expect(heard.audioMs).toBeGreaterThan(0);
    });
  });
}

export function paymentContract(
  label: string,
  setup: () => {
    provider: PaymentProvider;
    signedWebhook: (events: PaymentEvent[]) => RawWebhook;
    activeMandateId: (maxAmountPaise: number) => string;
  },
) {
  describe(`PaymentProvider contract: ${label}`, () => {
    it("creates payment links for positive paise amounts only", async () => {
      const { provider } = setup();
      const link = await provider.createPaymentLink({
        amountPaise: 150000,
        description: "RCT sitting 2",
        customerPhone: "+919876543210",
        referenceId: "ledger-1",
      });
      expect(link.url).toMatch(/^https:\/\//);
      await expect(
        provider.createPaymentLink({
          amountPaise: 0,
          description: "x",
          customerPhone: "+919876543210",
          referenceId: "ledger-2",
        }),
      ).rejects.toThrow();
    });

    it("charges within the mandate limit and refuses above it", async () => {
      const { provider, activeMandateId } = setup();
      const mandateId = activeMandateId(1_500_000);
      const ok = await provider.chargeMandate({
        providerMandateId: mandateId,
        amountPaise: 200_000,
        referenceId: "recharge-1",
      });
      expect(ok.providerPaymentId).toMatch(/\S/);
      await expect(
        provider.chargeMandate({ providerMandateId: mandateId, amountPaise: 1_500_001, referenceId: "r2" }),
      ).rejects.toThrow();
    });

    it("refuses to charge a cancelled mandate", async () => {
      const { provider, activeMandateId } = setup();
      const mandateId = activeMandateId(1_500_000);
      await provider.cancelMandate(mandateId);
      await expect(
        provider.chargeMandate({ providerMandateId: mandateId, amountPaise: 100, referenceId: "r3" }),
      ).rejects.toThrow();
    });

    it("verifies webhook signatures", () => {
      const { provider, signedWebhook } = setup();
      const webhook = signedWebhook([
        {
          type: "payment_captured",
          eventId: "pe1",
          providerPaymentId: "p1",
          amountPaise: 150000,
          referenceId: "ledger-1",
          method: "upi",
          at: new Date("2026-10-01T06:00:00Z"),
        },
      ]);
      expect(provider.verifyWebhook(webhook)).toBe(true);
      expect(provider.verifyWebhook(tamper(webhook))).toBe(false);
      expectStableEventIds(provider.parseWebhook(webhook));
    });
  });
}

export function storageContract(label: string, setup: () => { provider: StorageProvider }) {
  describe(`StorageProvider contract: ${label}`, () => {
    it("round-trips bytes and deletes", async () => {
      const { provider } = setup();
      const bytes = new TextEncoder().encode("%PDF-1.7 receipt");
      await provider.put({ key: "clinic-1/receipts/r1.pdf", bytes, contentType: "application/pdf" });
      const got = await provider.get("clinic-1/receipts/r1.pdf");
      expect(got?.contentType).toBe("application/pdf");
      expect(new TextDecoder().decode(got!.bytes)).toBe("%PDF-1.7 receipt");
      expect(await provider.signedUrl("clinic-1/receipts/r1.pdf", 300)).toMatch(/^https:\/\//);
      await provider.delete("clinic-1/receipts/r1.pdf");
      expect(await provider.get("clinic-1/receipts/r1.pdf")).toBeNull();
    });
  });
}

/**
 * Contract test suites. Every adapter (fake or real) must pass the suite for its provider type, so a new
 * provider can be swapped in with confidence. Real adapters run these against recorded fixtures in CI and
 * against the provider sandbox in the live smoke suite.
 */
import { describe, expect, it } from "vitest";
import type { RawWebhook } from "./common";
import type { MessagingEvent, MessagingProvider } from "./messaging/types";
import type { PaymentEvent, PaymentProvider } from "./payments/types";
import type { StorageProvider } from "./storage/types";
import type { TelephonyEvent, TelephonyProvider } from "./telephony/types";

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
) {
  describe(`MessagingProvider contract: ${label}`, () => {
    const inbound: MessagingEvent = {
      type: "inbound_message",
      eventId: "evt-1",
      providerMessageId: "m-1",
      from: "+919876543210",
      to: "+916512345678",
      at: new Date("2026-10-01T04:30:00Z"),
      content: { kind: "text", text: "RCT kitna ka hai?" },
    };

    it("accepts a correctly signed webhook and normalises events", () => {
      const { provider, signedWebhook } = setup();
      const webhook = signedWebhook([inbound]);
      expect(provider.verifyWebhook(webhook)).toBe(true);
      const events = provider.parseWebhook(webhook);
      expect(events).toEqual([inbound]);
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
        provider.sendText({ to: "+919876543210", text: "Namaste" }),
        provider.sendTemplate({
          to: "+919876543210",
          templateName: "appointment_reminder",
          language: "hi",
          bodyParams: ["Ramesh ji", "kal shaam 5 baje"],
        }),
        provider.sendButtons({
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
      await expect(provider.sendButtons({ to: "+919876543210", body: "x", buttons })).rejects.toThrow();
    });

    it("reports health", async () => {
      const { provider } = setup();
      expect(typeof (await provider.healthCheck()).ok).toBe("boolean");
    });
  });
}

export function telephonyContract(
  label: string,
  setup: () => {
    provider: TelephonyProvider;
    signedWebhook: (events: TelephonyEvent[]) => RawWebhook;
    /** Makes `number` pick up transfers (fake) or points at a sandbox number that answers (live). */
    answeringNumber: string;
  },
) {
  describe(`TelephonyProvider contract: ${label}`, () => {
    it("places calls and reports warm-transfer outcome", async () => {
      const { provider, answeringNumber } = setup();
      const { providerCallId } = await provider.placeCall({
        from: "+916512345678",
        to: "+919876543210",
        connectTo: { kind: "voice_agent", sipUri: "sip:agent@example" },
        record: true,
      });
      expect(providerCallId).toMatch(/\S/);
      await expect(
        provider.transferCall({ providerCallId, to: answeringNumber, ringTimeoutSec: 20 }),
      ).resolves.toEqual({ answered: true });
      await expect(
        provider.transferCall({ providerCallId, to: "+919000000001", ringTimeoutSec: 20 }),
      ).resolves.toEqual({ answered: false });
    });

    it("verifies webhook signatures", () => {
      const { provider, signedWebhook } = setup();
      const webhook = signedWebhook([
        {
          type: "missed",
          eventId: "e1",
          providerCallId: "c1",
          from: "+919876543210",
          to: "+916512345678",
          at: new Date("2026-10-01T15:00:00Z"),
        },
      ]);
      expect(provider.verifyWebhook(webhook)).toBe(true);
      expect(provider.verifyWebhook(tamper(webhook))).toBe(false);
      expectStableEventIds(provider.parseWebhook(webhook));
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

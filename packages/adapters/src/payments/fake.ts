import type { RawWebhook } from "../common.js";
import { ProviderError } from "../common.js";
import { FakeSupport, fakeId } from "../fake-support.js";
import type { PaymentEvent, PaymentProvider } from "./types.js";

export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake-payments";
  readonly support: FakeSupport;
  readonly links: { providerLinkId: string; amountPaise: number; referenceId: string }[] = [];
  readonly checkouts: { providerCheckoutId: string; referenceId: string; licenseAmountPaise: number }[] = [];
  readonly charges: { providerPaymentId: string; providerMandateId: string; amountPaise: number }[] = [];
  readonly mandates = new Map<string, { status: "active" | "cancelled"; maxAmountPaise: number }>();

  constructor(webhookSecret = "fake-payments-secret") {
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  async createPaymentLink(input: { amountPaise: number; referenceId: string }) {
    this.support.throwIfScripted();
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ProviderError(this.name, "bad_amount", "Amount must be positive paise", false);
    }
    const providerLinkId = fakeId("plink");
    this.links.push({ providerLinkId, amountPaise: input.amountPaise, referenceId: input.referenceId });
    return { providerLinkId, url: `https://pay.fake.local/${providerLinkId}` };
  }

  async createLicenseCheckout(input: { referenceId: string; licenseAmountPaise: number }) {
    this.support.throwIfScripted();
    const providerCheckoutId = fakeId("chk");
    this.checkouts.push({
      providerCheckoutId,
      referenceId: input.referenceId,
      licenseAmountPaise: input.licenseAmountPaise,
    });
    return { providerCheckoutId, url: `https://pay.fake.local/checkout/${providerCheckoutId}` };
  }

  /** Test helper: simulate the clinic completing checkout and authorising a mandate. */
  activateMandate(maxAmountPaise: number): string {
    const id = fakeId("mandate");
    this.mandates.set(id, { status: "active", maxAmountPaise });
    return id;
  }

  async chargeMandate(input: { providerMandateId: string; amountPaise: number }) {
    this.support.throwIfScripted();
    const mandate = this.mandates.get(input.providerMandateId);
    if (!mandate || mandate.status !== "active") {
      throw new ProviderError(this.name, "mandate_inactive", "Mandate is not active", false);
    }
    if (input.amountPaise > mandate.maxAmountPaise) {
      throw new ProviderError(this.name, "above_mandate_limit", "Amount exceeds mandate limit", false);
    }
    const providerPaymentId = fakeId("pay");
    this.charges.push({ providerPaymentId, ...input });
    return { providerPaymentId, status: "pending" as const };
  }

  async cancelMandate(providerMandateId: string) {
    const mandate = this.mandates.get(providerMandateId);
    if (mandate) mandate.status = "cancelled";
  }

  healthCheck() {
    return this.support.healthCheck();
  }

  verifyWebhook(webhook: RawWebhook) {
    return this.support.verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook) {
    return this.support.parseWebhook<PaymentEvent>(webhook);
  }

  eventWebhook(events: PaymentEvent[]): RawWebhook {
    return this.support.signWebhook(events);
  }
}

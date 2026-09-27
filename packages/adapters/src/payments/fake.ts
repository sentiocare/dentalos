import type { RawWebhook } from "../common";
import { ProviderError } from "../common";
import { FakeSupport, fakeId } from "../fake-support";
import type { PaymentAccount, PaymentEvent, PaymentProvider } from "./types";

export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake-payments";
  readonly support: FakeSupport;
  readonly links: {
    providerLinkId: string;
    amountPaise: number;
    referenceId: string;
    account: string | null;
  }[] = [];
  readonly registrations: { providerRegistrationId: string; referenceId: string; maxAmountPaise: number }[] =
    [];
  readonly charges: {
    providerPaymentId: string;
    providerMandateId: string;
    amountPaise: number;
    referenceId: string;
  }[] = [];
  readonly mandates = new Map<string, { status: "active" | "cancelled"; maxAmountPaise: number }>();
  private readonly secret: string;

  constructor(webhookSecret = "fake-payments-secret") {
    this.secret = webhookSecret;
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  async createPaymentLink(input: { amountPaise: number; referenceId: string }, account?: PaymentAccount) {
    this.support.throwIfScripted();
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ProviderError(this.name, "bad_amount", "Amount must be positive paise", false);
    }
    const providerLinkId = fakeId("plink");
    this.links.push({
      providerLinkId,
      amountPaise: input.amountPaise,
      referenceId: input.referenceId,
      account: account?.keyId ?? null,
    });
    return { providerLinkId, url: `https://pay.fake.local/${providerLinkId}` };
  }

  async createMandateRegistration(input: { referenceId: string; maxAmountPaise: number }) {
    this.support.throwIfScripted();
    const providerRegistrationId = fakeId("reg");
    this.registrations.push({
      providerRegistrationId,
      referenceId: input.referenceId,
      maxAmountPaise: input.maxAmountPaise,
    });
    return {
      providerRegistrationId,
      providerCustomerId: fakeId("cust"),
      url: `https://pay.fake.local/mandate/${providerRegistrationId}`,
    };
  }

  /** Test helper: simulate the clinic authorising a mandate on the hosted page. */
  activateMandate(maxAmountPaise: number, providerMandateId = fakeId("mandate")): string {
    this.mandates.set(providerMandateId, { status: "active", maxAmountPaise });
    return providerMandateId;
  }

  async chargeMandate(input: { providerMandateId: string; amountPaise: number; referenceId: string }) {
    this.support.throwIfScripted();
    const mandate = this.mandates.get(input.providerMandateId);
    if (!mandate || mandate.status !== "active") {
      throw new ProviderError(this.name, "mandate_inactive", "Mandate is not active", false);
    }
    if (input.amountPaise > mandate.maxAmountPaise) {
      throw new ProviderError(this.name, "above_mandate_limit", "Amount exceeds mandate limit", false);
    }
    const providerPaymentId = fakeId("pay");
    this.charges.push({
      providerPaymentId,
      providerMandateId: input.providerMandateId,
      amountPaise: input.amountPaise,
      referenceId: input.referenceId,
    });
    return { providerPaymentId, status: "pending" as const };
  }

  async cancelMandate(providerMandateId: string) {
    const mandate = this.mandates.get(providerMandateId);
    if (mandate) mandate.status = "cancelled";
  }

  healthCheck() {
    return this.support.healthCheck();
  }

  private supportFor(account?: PaymentAccount) {
    return account && account.webhookSecret !== this.secret
      ? new FakeSupport(this.name, account.webhookSecret)
      : this.support;
  }

  verifyWebhook(webhook: RawWebhook, account?: PaymentAccount) {
    return this.supportFor(account).verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook, account?: PaymentAccount) {
    return this.supportFor(account).parseWebhook<PaymentEvent>(webhook);
  }

  /** Test helper: a webhook as the gateway would send it (signed with the account's secret). */
  eventWebhook(events: PaymentEvent[], account?: PaymentAccount): RawWebhook {
    return this.supportFor(account).signWebhook(events);
  }
}

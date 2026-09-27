import type { ProviderBase, RawWebhook } from "../common";

/**
 * Payment gateway (Razorpay in production). Card and bank details are only ever entered on the gateway's
 * hosted pages; nothing sensitive passes through our servers.
 *
 * Two kinds of account use it:
 * - Sentio's own account (the default, from environment variables): license payments and usage-wallet
 *   recharges, including mandates.
 * - A clinic's own account (passed as `account`): patients paying the clinic. The money never passes
 *   through Sentio.
 */
export interface PaymentAccount {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface PaymentProvider extends ProviderBase {
  /** UPI/card payment link: a patient's dues or advance, a license, or a manual wallet top-up. */
  createPaymentLink(
    input: {
      amountPaise: number;
      description: string;
      customerPhone: string;
      referenceId: string;
      expiresAt?: Date;
    },
    account?: PaymentAccount,
  ): Promise<{ providerLinkId: string; url: string }>;
  /**
   * Hosted page where the clinic authorises a mandate (UPI Autopay / card / e-NACH) used only for
   * usage-wallet recharges, up to `maxAmountPaise` per debit. Always on Sentio's account.
   */
  createMandateRegistration(input: {
    referenceId: string;
    maxAmountPaise: number;
    method: "upi_autopay" | "card" | "enach";
    customer: { name: string; phone: string; email?: string };
  }): Promise<{ providerRegistrationId: string; providerCustomerId: string; url: string }>;
  /** Debits a recharge against an active mandate. The caller must have sent the pre-debit notice. */
  chargeMandate(input: {
    providerMandateId: string;
    amountPaise: number;
    referenceId: string;
    customer: { phone: string; email?: string };
  }): Promise<{ providerPaymentId: string; status: "pending" | "captured" | "failed" }>;
  cancelMandate(providerMandateId: string): Promise<void>;
  /** Checks the signature with the account's webhook secret (Sentio's when no account is given). */
  verifyWebhook(webhook: RawWebhook, account?: PaymentAccount): boolean;
  /** Verifies, then normalises the payload into our events. Each event carries a stable id for dedupe. */
  parseWebhook(webhook: RawWebhook, account?: PaymentAccount): PaymentEvent[];
}

export type PaymentEvent =
  | {
      type: "payment_captured";
      eventId: string;
      providerPaymentId: string;
      amountPaise: number;
      referenceId: string;
      method: "upi" | "card" | "netbanking" | "other";
      at: Date;
    }
  | {
      type: "payment_failed";
      eventId: string;
      providerPaymentId: string;
      referenceId: string;
      reason: string;
      at: Date;
    }
  | {
      type: "mandate_status";
      eventId: string;
      providerMandateId: string;
      providerCustomerId: string;
      status: "active" | "paused" | "cancelled" | "failed";
      method?: "upi_autopay" | "card" | "enach";
      maxAmountPaise?: number;
      at: Date;
    };

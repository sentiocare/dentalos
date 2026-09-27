import type { ProviderBase, WebhookReceiver } from "../common";

/**
 * Payment gateway (Razorpay in production). Card and bank details are only ever entered on the gateway's
 * hosted pages; nothing sensitive passes through our servers.
 */
export interface PaymentProvider extends ProviderBase, WebhookReceiver<PaymentEvent> {
  /** UPI/card payment link for a patient's dues, or for a manual wallet top-up. */
  createPaymentLink(input: {
    amountPaise: number;
    description: string;
    customerPhone: string;
    referenceId: string;
    expiresAt?: Date;
  }): Promise<{ providerLinkId: string; url: string }>;
  /**
   * Hosted checkout used once at onboarding: collects the one-time license payment and authorises a mandate
   * (UPI Autopay / card / e-NACH) that is only ever used for usage-wallet recharges.
   */
  createLicenseCheckout(input: {
    referenceId: string;
    licenseAmountPaise: number;
    mandateMaxAmountPaise: number;
    customer: { name: string; phone: string; email?: string };
  }): Promise<{ providerCheckoutId: string; url: string }>;
  /** Debits a recharge against an active mandate. The caller must have sent the pre-debit notice. */
  chargeMandate(input: {
    providerMandateId: string;
    amountPaise: number;
    referenceId: string;
  }): Promise<{ providerPaymentId: string; status: "pending" | "captured" | "failed" }>;
  cancelMandate(providerMandateId: string): Promise<void>;
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
      referenceId: string;
      status: "active" | "paused" | "cancelled" | "failed";
      method?: "upi_autopay" | "card" | "enach";
      maxAmountPaise?: number;
      at: Date;
    };

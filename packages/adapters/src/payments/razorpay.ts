import { createHash } from "node:crypto";
import { hmacSha256Hex, ProviderError, safeEqualHex, type RawWebhook } from "../common";
import type { PaymentAccount, PaymentEvent, PaymentProvider } from "./types";

export interface RazorpayConfig {
  /** Sentio's own account: licenses and wallet recharges. */
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const METHOD: Record<string, "upi_autopay" | "card" | "enach"> = {
  upi: "upi_autopay",
  card: "card",
  emandate: "enach",
  nach: "enach",
};
const TOKEN_STATUS: Record<string, "active" | "paused" | "cancelled" | "failed"> = {
  "token.confirmed": "active",
  "token.paused": "paused",
  "token.cancelled": "cancelled",
  "token.rejected": "failed",
};

function payMethod(m: unknown): "upi" | "card" | "netbanking" | "other" {
  return m === "upi" || m === "card" || m === "netbanking" ? m : "other";
}

/**
 * Razorpay (https://razorpay.com/docs/api/). Payment Links for one-off payments; recurring payments
 * ("subscription registration" links, then recurring charges on the saved token) for wallet mandates.
 * A mandate is stored as "customer_id:token_id", because a recurring charge needs both.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = "razorpay";
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: RazorpayConfig) {
    this.base = (config.apiBase ?? "https://api.razorpay.com/v1").replace(/\/$/, "");
    this.fetch = config.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body: unknown, account?: PaymentAccount): Promise<T> {
    const keyId = account?.keyId ?? this.config.keyId;
    const keySecret = account?.keySecret ?? this.config.keySecret;
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ProviderError(this.name, "network", String(error), true);
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    } & T;
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new ProviderError(
        this.name,
        data.error?.code ?? `http_${res.status}`,
        data.error?.description ?? `Razorpay returned ${res.status}`,
        retryable,
      );
    }
    return data;
  }

  async createPaymentLink(
    input: {
      amountPaise: number;
      description: string;
      customerPhone: string;
      referenceId: string;
      expiresAt?: Date;
    },
    account?: PaymentAccount,
  ) {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0)
      throw new ProviderError(this.name, "bad_amount", "Amount must be positive paise", false);
    const link = await this.call<{ id: string; short_url: string }>(
      "POST",
      "/payment_links",
      {
        amount: input.amountPaise,
        currency: "INR",
        accept_partial: false,
        description: input.description.slice(0, 2048),
        customer: { contact: input.customerPhone },
        // We send the link on WhatsApp ourselves.
        notify: { sms: false, email: false },
        reminder_enable: false,
        // Razorpay allows 40 characters; our references are shorter.
        reference_id: input.referenceId.slice(0, 40),
        ...(input.expiresAt ? { expire_by: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
        notes: { reference_id: input.referenceId },
      },
      account,
    );
    return { providerLinkId: link.id, url: link.short_url };
  }

  async createMandateRegistration(input: {
    referenceId: string;
    maxAmountPaise: number;
    method: "upi_autopay" | "card" | "enach";
    customer: { name: string; phone: string; email?: string };
  }) {
    const method = input.method === "upi_autopay" ? "upi" : input.method === "enach" ? "emandate" : "card";
    const link = await this.call<{ id: string; short_url: string; customer_id: string }>(
      "POST",
      "/subscription_registration/auth_links",
      {
        customer: {
          name: input.customer.name.slice(0, 50),
          contact: input.customer.phone,
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        type: "link",
        // e-NACH needs no authorisation payment; UPI and cards take ₹1, which is credited to the wallet.
        amount: method === "emandate" ? 0 : 100,
        currency: "INR",
        description: "Sentio usage wallet: automatic recharge",
        subscription_registration: {
          method,
          max_amount: input.maxAmountPaise,
          frequency: "as_presented",
          expire_at: Math.floor(Date.now() / 1000) + 10 * 365 * 86_400,
        },
        receipt: input.referenceId.slice(0, 40),
        sms_notify: false,
        email_notify: false,
        notes: { reference_id: input.referenceId },
      },
    );
    return { providerRegistrationId: link.id, providerCustomerId: link.customer_id, url: link.short_url };
  }

  private splitMandate(id: string) {
    const [customerId, tokenId] = id.split(":");
    if (!customerId || !tokenId)
      throw new ProviderError(this.name, "bad_mandate", "Mandate id must be customer:token", false);
    return { customerId, tokenId };
  }

  async chargeMandate(input: {
    providerMandateId: string;
    amountPaise: number;
    referenceId: string;
    customer: { phone: string; email?: string };
  }) {
    const { customerId, tokenId } = this.splitMandate(input.providerMandateId);
    const order = await this.call<{ id: string }>("POST", "/orders", {
      amount: input.amountPaise,
      currency: "INR",
      payment_capture: true,
      receipt: input.referenceId.slice(0, 40),
      notes: { reference_id: input.referenceId },
    });
    const payment = await this.call<{ razorpay_payment_id: string }>("POST", "/payments/create/recurring", {
      email: input.customer.email ?? "billing@sentio.invalid",
      contact: input.customer.phone,
      amount: input.amountPaise,
      currency: "INR",
      order_id: order.id,
      customer_id: customerId,
      token: tokenId,
      recurring: "1",
      description: "Sentio usage wallet recharge",
      notes: { reference_id: input.referenceId },
    });
    // The result arrives by webhook (payment.captured or payment.failed).
    return { providerPaymentId: payment.razorpay_payment_id, status: "pending" as const };
  }

  async cancelMandate(providerMandateId: string) {
    const { customerId, tokenId } = this.splitMandate(providerMandateId);
    await this.call("DELETE", `/customers/${customerId}/tokens/${tokenId}`, undefined);
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.call("GET", "/payment_links?count=1", undefined);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, detail: error instanceof ProviderError ? error.code : "unreachable" };
    }
  }

  verifyWebhook(webhook: RawWebhook, account?: PaymentAccount): boolean {
    const signature = webhook.headers["x-razorpay-signature"];
    const secret = account?.webhookSecret ?? this.config.webhookSecret;
    return !!signature && safeEqualHex(signature, hmacSha256Hex(secret, webhook.rawBody));
  }

  parseWebhook(webhook: RawWebhook, account?: PaymentAccount): PaymentEvent[] {
    if (!this.verifyWebhook(webhook, account))
      throw new ProviderError(this.name, "bad_signature", "Webhook signature invalid", false);
    const body = JSON.parse(webhook.rawBody) as {
      event: string;
      created_at?: number;
      payload: Record<string, { entity: Record<string, unknown> } | undefined>;
    };
    // Razorpay sends a unique id per event in a header; fall back to a hash of the body.
    const eventId =
      webhook.headers["x-razorpay-event-id"] ?? createHash("sha256").update(webhook.rawBody).digest("hex");
    const at = new Date((body.created_at ?? Math.floor(Date.now() / 1000)) * 1000);
    const payment = body.payload.payment?.entity as
      | {
          id: string;
          amount: number;
          method?: string;
          notes?: { reference_id?: string } | unknown[];
          error_description?: string;
        }
      | undefined;
    const noteRef = (n: unknown) =>
      n && !Array.isArray(n) ? ((n as { reference_id?: string }).reference_id ?? null) : null;

    switch (body.event) {
      case "payment_link.paid": {
        const link = body.payload.payment_link?.entity as { reference_id?: string; notes?: unknown };
        const referenceId = noteRef(link?.notes) ?? link?.reference_id;
        if (!payment || !referenceId) return [];
        return [
          {
            type: "payment_captured",
            eventId,
            providerPaymentId: payment.id,
            amountPaise: payment.amount,
            referenceId,
            method: payMethod(payment.method),
            at,
          },
        ];
      }
      case "payment.captured": {
        const referenceId = noteRef(payment?.notes);
        // Payment-link payments are handled by payment_link.paid; this covers recurring charges.
        if (!payment || !referenceId) return [];
        return [
          {
            type: "payment_captured",
            eventId,
            providerPaymentId: payment.id,
            amountPaise: payment.amount,
            referenceId,
            method: payMethod(payment.method),
            at,
          },
        ];
      }
      case "payment.failed": {
        const referenceId = noteRef(payment?.notes);
        if (!payment || !referenceId) return [];
        return [
          {
            type: "payment_failed",
            eventId,
            providerPaymentId: payment.id,
            referenceId,
            reason: payment.error_description ?? "payment failed",
            at,
          },
        ];
      }
      default: {
        const status = TOKEN_STATUS[body.event];
        const token = body.payload.token?.entity as
          { id: string; customer_id: string; method?: string; max_amount?: number } | undefined;
        if (!status || !token) return [];
        return [
          {
            type: "mandate_status",
            eventId,
            providerMandateId: `${token.customer_id}:${token.id}`,
            providerCustomerId: token.customer_id,
            status,
            method: token.method ? METHOD[token.method] : undefined,
            maxAmountPaise: token.max_amount,
            at,
          },
        ];
      }
    }
  }
}

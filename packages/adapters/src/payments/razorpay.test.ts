import { describe, expect, it } from "vitest";
import { hmacSha256Hex, type RawWebhook } from "../common";
import { paymentContract } from "../testing";
import { RazorpayPaymentProvider } from "./razorpay";
import type { PaymentAccount, PaymentEvent } from "./types";

const SENTIO = {
  keyId: "rzp_live_sentio",
  keySecret: "sentio-secret",
  webhookSecret: "sentio-webhook-secret",
};

/** An in-memory stand-in for the Razorpay REST API (the request and response shapes our adapter uses). */
function fakeRazorpay() {
  const calls: { method: string; path: string; auth: string; body: Record<string, unknown> | null }[] = [];
  const tokens = new Map<string, { status: string; max: number }>();
  let n = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/v1", "") + new URL(url).search;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = Buffer.from(
      String((init.headers as Record<string, string>).authorization).slice(6),
      "base64",
    )
      .toString()
      .split(":")[0]!;
    calls.push({ method: init.method ?? "GET", path, auth, body });
    const bad = (description: string) =>
      new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description } }), { status: 400 });
    if (path === "/payment_links" && init.method === "POST") {
      if (!(Number(body!.amount) >= 100)) return bad("amount must be at least 100");
      return Response.json({ id: `plink_${++n}`, short_url: `https://rzp.io/i/${n}` });
    }
    if (path === "/subscription_registration/auth_links")
      return Response.json({
        id: `inv_${++n}`,
        short_url: `https://rzp.io/i/r${n}`,
        customer_id: `cust_${n}`,
      });
    if (path === "/orders") return Response.json({ id: `order_${++n}` });
    if (path === "/payments/create/recurring") {
      const t = tokens.get(`${body!.customer_id}:${body!.token}`);
      if (!t || t.status !== "confirmed") return bad("token is not active");
      if (Number(body!.amount) > t.max) return bad("amount exceeds maximum amount");
      return Response.json({ razorpay_payment_id: `pay_${++n}`, razorpay_order_id: body!.order_id });
    }
    const del = path.match(/^\/customers\/(.+)\/tokens\/(.+)$/);
    if (del && init.method === "DELETE") {
      const t = tokens.get(`${del[1]}:${del[2]}`);
      if (t) t.status = "cancelled";
      return Response.json({ deleted: true });
    }
    if (path.startsWith("/payment_links?")) return Response.json({ payment_links: [] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    token(max: number) {
      const id = `cust_${++n}:token_${n}`;
      tokens.set(id, { status: "confirmed", max });
      return id;
    },
  };
}

/** Razorpay's webhook format for one of our events, signed like Razorpay signs it. */
function razorpayWebhook(events: PaymentEvent[], secret: string): RawWebhook {
  const e = events[0]!;
  const created_at = Math.floor(e.at.getTime() / 1000);
  let body: unknown;
  if (e.type === "payment_captured")
    body = {
      event: "payment_link.paid",
      created_at,
      payload: {
        payment_link: {
          entity: { id: "plink_1", reference_id: e.referenceId, notes: { reference_id: e.referenceId } },
        },
        payment: { entity: { id: e.providerPaymentId, amount: e.amountPaise, method: e.method } },
      },
    };
  else if (e.type === "payment_failed")
    body = {
      event: "payment.failed",
      created_at,
      payload: {
        payment: {
          entity: {
            id: e.providerPaymentId,
            amount: 100,
            notes: { reference_id: e.referenceId },
            error_description: e.reason,
          },
        },
      },
    };
  else
    body = {
      event: "token.confirmed",
      created_at,
      payload: {
        token: {
          entity: {
            id: e.providerMandateId.split(":")[1],
            customer_id: e.providerCustomerId,
            method: "upi",
            max_amount: e.maxAmountPaise,
          },
        },
      },
    };
  const rawBody = JSON.stringify(body);
  return {
    headers: {
      "x-razorpay-signature": hmacSha256Hex(secret, rawBody),
      "x-razorpay-event-id": `evt_${e.eventId}`,
    },
    rawBody,
  };
}

paymentContract("razorpay (recorded API shapes)", () => {
  const api = fakeRazorpay();
  return {
    provider: new RazorpayPaymentProvider({ ...SENTIO, fetchImpl: api.fetchImpl }),
    signedWebhook: (events, account?: PaymentAccount) =>
      razorpayWebhook(events, account?.webhookSecret ?? SENTIO.webhookSecret),
    activeMandateId: (max) => api.token(max),
  };
});

describe("Razorpay", () => {
  it("uses the clinic's own keys for a clinic's payment link and Sentio's keys otherwise", async () => {
    const api = fakeRazorpay();
    const rp = new RazorpayPaymentProvider({ ...SENTIO, fetchImpl: api.fetchImpl });
    const clinic = { keyId: "rzp_live_clinic", keySecret: "c", webhookSecret: "cw" };
    await rp.createPaymentLink(
      { amountPaise: 50000, description: "Dues", customerPhone: "+919876543210", referenceId: "plink:abc" },
      clinic,
    );
    await rp.createPaymentLink({
      amountPaise: 50000,
      description: "Wallet",
      customerPhone: "+919876543210",
      referenceId: "topup:1",
    });
    expect(api.calls.map((c) => c.auth)).toEqual(["rzp_live_clinic", "rzp_live_sentio"]);
    // We send links on WhatsApp ourselves: Razorpay must not SMS or email the patient.
    expect(api.calls[0]!.body).toMatchObject({ notify: { sms: false, email: false }, currency: "INR" });
  });

  it("a recurring charge creates an order then charges the saved token", async () => {
    const api = fakeRazorpay();
    const rp = new RazorpayPaymentProvider({ ...SENTIO, fetchImpl: api.fetchImpl });
    const mandate = api.token(1_500_000);
    await rp.chargeMandate({
      providerMandateId: mandate,
      amountPaise: 200000,
      referenceId: "recharge:r1",
      customer: { phone: "+919876543210" },
    });
    expect(api.calls.map((c) => c.path)).toEqual(["/orders", "/payments/create/recurring"]);
    expect(api.calls[1]!.body).toMatchObject({ recurring: "1", notes: { reference_id: "recharge:r1" } });
  });

  it("normalises webhooks: link paid, recurring payment captured, token events; ignores the rest", () => {
    const rp = new RazorpayPaymentProvider(SENTIO);
    const sign = (body: unknown, id = "evt_1"): RawWebhook => {
      const rawBody = JSON.stringify(body);
      return {
        headers: {
          "x-razorpay-signature": hmacSha256Hex(SENTIO.webhookSecret, rawBody),
          "x-razorpay-event-id": id,
        },
        rawBody,
      };
    };
    expect(
      rp.parseWebhook(
        sign({
          event: "payment.captured",
          created_at: 1790000000,
          payload: {
            payment: {
              entity: { id: "pay_9", amount: 200000, method: "upi", notes: { reference_id: "recharge:r1" } },
            },
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "payment_captured",
        providerPaymentId: "pay_9",
        referenceId: "recharge:r1",
        eventId: "evt_1",
      }),
    ]);
    // A payment without our reference (e.g. made on the dashboard) is not ours to book.
    expect(
      rp.parseWebhook(
        sign({
          event: "payment.captured",
          payload: { payment: { entity: { id: "pay_1", amount: 1, notes: [] } } },
        }),
      ),
    ).toEqual([]);
    expect(
      rp.parseWebhook(
        sign({
          event: "token.rejected",
          payload: { token: { entity: { id: "token_1", customer_id: "cust_1", method: "emandate" } } },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "mandate_status",
        status: "failed",
        providerMandateId: "cust_1:token_1",
        method: "enach",
      }),
    ]);
    expect(rp.parseWebhook(sign({ event: "order.paid", payload: {} }))).toEqual([]);
  });
});

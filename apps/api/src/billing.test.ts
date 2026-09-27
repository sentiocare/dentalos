import { createAdapters, FakePaymentProvider } from "@dentalos/adapters";
import { createClinic, MemoryJobQueue } from "@dentalos/core";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = {
  jwtSecret: "test-secret-that-is-long-enough-1234567890",
  audience: "authenticated",
  devLogin: true,
};

describe.skipIf(!hasTestDatabase)("billing API: patient accounts, receipts, invoices, payment links", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let clinicId: string;
  let owner: string;
  let reception: string;
  let assistant: string;
  let patientId: string;
  const jobs = new MemoryJobQueue();
  const adapters = createAdapters({
    messaging: "fake",
    telephony: "fake",
    voice: "fake",
    llm: "fake",
    payments: "fake",
    sms: "fake",
    storage: "fake",
  });
  const payments = adapters.payments as FakePaymentProvider;
  const login = async (phone: string) =>
    (await app.inject({ method: "POST", url: "/v1/dev/login", payload: { phone } })).json().token as string;
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Billing Dental",
        owner: { name: "Dr. B", phone: "9835000081" },
      }));
    } finally {
      client.release();
    }
    app = buildApp({
      pool: db.pool,
      adapters,
      logger,
      version: "test",
      auth,
      jobs,
      channelKey: Buffer.alloc(32, 3),
    });
    owner = await login("9835000081");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", { phone: "98350 00082", name: "Reception", role: "receptionist" });
    await call(owner, "POST", "/v1/staff", { phone: "98350 00083", name: "Assistant", role: "assistant" });
    reception = await login("9835000082");
    await call(reception, "GET", "/v1/me");
    assistant = await login("9835000083");
    await call(assistant, "GET", "/v1/me");
    patientId = (
      await call(owner, "POST", "/v1/patients", { name: "Sita Devi", phone: "98765 22222" })
    ).json().id;
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("reception charges and takes payment; a retried payment is booked once; the receipt goes out", async () => {
    expect(
      (
        await call(reception, "POST", `/v1/patients/${patientId}/charges`, {
          amountPaise: 400000,
          description: "RCT sitting",
        })
      ).statusCode,
    ).toBe(200);
    const body = {
      amountPaise: 150000,
      method: "upi",
      reference: "UPI-1",
      sendReceipt: true,
      clientKey: "k-offline-0001",
    };
    const first = (await call(reception, "POST", `/v1/patients/${patientId}/payments`, body)).json();
    const again = (await call(reception, "POST", `/v1/patients/${patientId}/payments`, body)).json();
    expect(first.receiptNumber).toMatch(/^R\/\d{4}-\d{2}\/0001$/);
    expect(again).toMatchObject({ id: first.id, duplicate: true, receiptSent: false });
    expect(first.receiptSent).toBe(true);
    const account = (await call(reception, "GET", `/v1/patients/${patientId}/account`)).json();
    expect(account.balancePaise).toBe(250000);
    const pdf = await call(reception, "GET", `/v1/receipts/${first.receiptId}/pdf`);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("permissions: assistants see no bills; only the owner (by default) gives discounts or reverses", async () => {
    expect((await call(assistant, "GET", `/v1/patients/${patientId}/account`)).statusCode).toBe(403);
    const adj = { amountPaise: -10000, description: "Senior citizen" };
    expect((await call(reception, "POST", `/v1/patients/${patientId}/adjustments`, adj)).statusCode).toBe(
      403,
    );
    expect((await call(owner, "POST", `/v1/patients/${patientId}/adjustments`, adj)).statusCode).toBe(200);
    const account = (await call(owner, "GET", `/v1/patients/${patientId}/account`)).json();
    expect(account.balancePaise).toBe(240000);
    const pay = account.entries.find((e: { kind: string }) => e.kind === "payment");
    expect((await call(reception, "POST", `/v1/ledger/${pay.id}/reverse`, { reason: "x" })).statusCode).toBe(
      403,
    );
    expect(
      (await call(assistant, "GET", "/v1/collections?from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z"))
        .statusCode,
    ).toBe(403);
  });

  it("invoice and its PDF; collections and dues for staff who may see revenue", async () => {
    const inv = await call(reception, "POST", `/v1/patients/${patientId}/invoices`, {});
    expect(inv.statusCode).toBe(200);
    expect((await call(reception, "GET", `/v1/invoices/${inv.json().id}/pdf`)).headers["content-type"]).toBe(
      "application/pdf",
    );
    const col = (
      await call(owner, "GET", "/v1/collections?from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z")
    ).json();
    expect(col.totals.byMethod.upi).toBe(150000);
    expect(col.dues).toEqual({ patients: 1, totalPaise: 240000 });
    const dues = (await call(owner, "GET", "/v1/dues")).json();
    expect(dues[0]).toMatchObject({ name: "Sita Devi", balancePaise: 240000 });
  });

  it("payment link paid by webhook: signed with the clinic's secret, booked once, receipt queued", async () => {
    const keys = {
      keyId: "rzp_test_clinic01",
      keySecret: "clinic-key-secret",
      webhookSecret: "clinic-webhook-1",
    };
    expect((await call(reception, "PUT", "/v1/payments-account", keys)).statusCode).toBe(403);
    const connected = await call(owner, "PUT", "/v1/payments-account", keys);
    expect(connected.json().webhookPath).toBe(`/webhooks/payments/clinic/${clinicId}`);
    expect((await call(owner, "GET", "/v1/payments-account")).json()).toEqual({
      connected: true,
      keyId: keys.keyId,
    });

    const link = (
      await call(reception, "POST", `/v1/patients/${patientId}/payment-links`, { amountPaise: 240000 })
    ).json();
    expect(payments.links.at(-1)).toMatchObject({ account: keys.keyId, referenceId: `plink:${link.id}` });
    const event = {
      type: "payment_captured" as const,
      eventId: "evt-link-1",
      providerPaymentId: "pay_link_1",
      amountPaise: 240000,
      referenceId: `plink:${link.id}`,
      method: "upi" as const,
      at: new Date(),
    };
    const post = (webhook: { headers: Record<string, string | undefined>; rawBody: string }, id = clinicId) =>
      app.inject({
        method: "POST",
        url: `/webhooks/payments/clinic/${id}`,
        headers: { ...webhook.headers, "content-type": "application/json" } as Record<string, string>,
        payload: webhook.rawBody,
      });
    // Signed with Sentio's secret instead of the clinic's: refused.
    expect((await post(payments.eventWebhook([event]))).statusCode).toBe(401);
    const signed = payments.eventWebhook([event], keys);
    expect((await post(signed)).statusCode).toBe(200);
    expect((await post(signed)).statusCode).toBe(200); // the gateway retries
    const account = (await call(owner, "GET", `/v1/patients/${patientId}/account`)).json();
    expect(account.balancePaise).toBe(0);
    expect(account.entries.filter((e: { method: string }) => e.method === "gateway_link")).toHaveLength(1);
    expect(jobs.jobs.filter((j) => j.task === "send_receipt")).toHaveLength(1);

    // Another clinic's URL cannot book this clinic's link.
    const client = await db.pool.connect();
    let other: string;
    try {
      ({ clinicId: other } = await createClinic(client, {
        name: "Other Dental",
        owner: { name: "Dr. O", phone: "9835000089" },
      }));
    } finally {
      client.release();
    }
    const stolen = payments.eventWebhook([
      { ...event, eventId: "evt-link-2", providerPaymentId: "pay_link_2" },
    ]);
    expect((await post(stolen, other)).statusCode).toBe(200);
    expect((await call(owner, "GET", `/v1/patients/${patientId}/account`)).json().balancePaise).toBe(0);
  });
});

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

describe.skipIf(!hasTestDatabase)("wallet and Sentio admin API", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let clinicId: string;
  let owner: string;
  let reception: string;
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
  const webhook = (events: Parameters<FakePaymentProvider["eventWebhook"]>[0], signed = true) => {
    const w = payments.eventWebhook(
      events,
      signed ? undefined : { keyId: "x", keySecret: "y", webhookSecret: "wrong-secret" },
    );
    return app.inject({
      method: "POST",
      url: "/webhooks/payments/sentio",
      headers: { ...w.headers, "content-type": "application/json" } as Record<string, string>,
      payload: w.rawBody,
    });
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Wallet API Dental",
        owner: { name: "Dr. W", phone: "9835000111" },
      }));
    } finally {
      client.release();
    }
    app = buildApp({ pool: db.pool, adapters, logger, version: "test", auth, jobs, channelKey: null });
    owner = await login("9835000111");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", { phone: "98350 00112", name: "Reception", role: "receptionist" });
    reception = await login("9835000112");
    await call(reception, "GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("the owner sees the wallet; reception does not", async () => {
    const w = (await call(owner, "GET", "/v1/wallet")).json();
    expect(w).toMatchObject({ enforced: false, balancePaise: 0, license: null, mandate: null });
    expect((await call(reception, "GET", "/v1/wallet")).statusCode).toBe(403);
  });

  it("settings: automatic recharges stay at or below ₹15,000", async () => {
    expect((await call(owner, "PATCH", "/v1/wallet", { rechargeAmountPaise: 2_000_000 })).statusCode).toBe(
      400,
    );
    expect(
      (await call(owner, "PATCH", "/v1/wallet", { rechargeAmountPaise: 500_000, monthlyCapPaise: 1_000_000 }))
        .statusCode,
    ).toBe(200);
    expect((await call(owner, "GET", "/v1/wallet")).json()).toMatchObject({
      rechargeAmountPaise: 500_000,
      monthlyCapPaise: 1_000_000,
    });
  });

  it("top-up by link, paid by webhook on Sentio's account: credited once, invoiced; bad signatures refused", async () => {
    const link = (await call(owner, "POST", "/v1/wallet/topup", { amountPaise: 236000 })).json();
    expect(link.url).toMatch(/^https:\/\//);
    const event = {
      type: "payment_captured" as const,
      eventId: "evt-topup-1",
      providerPaymentId: "pay_topup_1",
      amountPaise: 236000,
      referenceId: `recharge:${link.rechargeId}`,
      method: "upi" as const,
      at: new Date(),
    };
    expect((await webhook([event], false)).statusCode).toBe(401);
    expect((await webhook([event])).statusCode).toBe(200);
    expect((await webhook([event])).statusCode).toBe(200);
    const w = (await call(owner, "GET", "/v1/wallet")).json();
    expect(w.balancePaise).toBe(200000); // ₹2,360 paid = ₹2,000 credit + ₹360 GST
    expect(w.invoices).toHaveLength(1);
    const pdf = await call(owner, "GET", `/v1/wallet/invoices/${w.invoices[0].id}/pdf`);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
  });

  it("the owner can start the automatic-recharge mandate", async () => {
    const reg = await call(owner, "POST", "/v1/wallet/mandate", { method: "upi_autopay" });
    expect(reg.statusCode).toBe(200);
    expect((await call(owner, "GET", "/v1/wallet")).json().mandate).toMatchObject({
      status: "pending",
      method: "upi_autopay",
    });
  });

  it("Sentio admin: only platform admins; sells the license, switches billing on, sets rates, reconciles", async () => {
    expect((await call(owner, "GET", "/v1/admin/clinics")).statusCode).toBe(403);
    expect((await call(owner, "GET", "/v1/me")).json().platformAdmin).toBe(false);
    const adminUser = (await db.pool.query("select id from users where phone = '+919835000112'")).rows[0].id;
    await db.pool.query("insert into platform_admins (user_id) values ($1)", [adminUser]);
    const admin = reception; // the same person, now also Sentio staff
    expect((await call(admin, "GET", "/v1/me")).json().platformAdmin).toBe(true);

    const clinics = (await call(admin, "GET", "/v1/admin/clinics")).json();
    expect(clinics.find((c: { id: string }) => c.id === clinicId)).toMatchObject({
      balancePaise: 200000,
      enforced: false,
    });

    const lic = (
      await call(admin, "POST", `/v1/admin/clinics/${clinicId}/license`, {
        sku: "standard",
        pricePaise: 2_999_900,
      })
    ).json();
    expect(lic.totalPaise).toBe(2_999_900 + 539_982);
    expect(lic.outboxId).toBeTruthy(); // the link went to the owner on WhatsApp
    await webhook([
      {
        type: "payment_captured",
        eventId: "evt-license",
        providerPaymentId: "pay_license",
        amountPaise: lic.totalPaise,
        referenceId: `license:${lic.licenseId}`,
        method: "card",
        at: new Date(),
      },
    ]);
    const detail = (await call(admin, "GET", `/v1/admin/clinics/${clinicId}`)).json();
    expect(detail.wallet.enforced).toBe(true);
    expect(detail.licenses[0].status).toBe("paid");

    const adj = await call(admin, "POST", `/v1/admin/clinics/${clinicId}/wallet`, { adjustmentPaise: 5000 });
    expect(adj.statusCode).toBe(400); // a reason is required
    expect(
      (
        await call(admin, "POST", `/v1/admin/clinics/${clinicId}/wallet`, {
          adjustmentPaise: 5000,
          note: "Goodwill credit",
        })
      ).json(),
    ).toMatchObject({ balance_paise: 205000 });

    const past = await call(admin, "POST", "/v1/admin/rates", {
      kind: "wa_utility",
      unit: "message",
      providerCostPaise: 11.5,
      marginPct: 30,
      effectiveFrom: "2020-01-01T00:00:00Z",
    });
    expect(past.statusCode).toBe(400); // past usage keeps its price
    const future = await call(admin, "POST", "/v1/admin/rates", {
      kind: "wa_utility",
      unit: "message",
      providerCostPaise: 11.5,
      marginPct: 30,
      effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(future.statusCode).toBe(200);

    const rec = (
      await call(admin, "POST", "/v1/admin/reconciliation", {
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        bills: { telephony: 0 },
      })
    ).json();
    expect(rec.find((r: { provider: string }) => r.provider === "wallet_balances").status).toBe("ok");
    const health = (await call(admin, "GET", "/v1/admin/health")).json();
    expect(health.providers.map((p: { role: string }) => p.role)).toContain("payments");
  });
});

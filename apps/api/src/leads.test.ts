import { createAdapters, FakeLeadAdsProvider } from "@dentalos/adapters";
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

describe.skipIf(!hasTestDatabase)("leads API", () => {
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
  const leads = adapters.leads as FakeLeadAdsProvider;
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
        name: "Lead API Dental",
        owner: { name: "Dr. A", phone: "9835000131" },
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
      channelKey: Buffer.alloc(32, 9),
    });
    owner = await login("9835000131");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", { phone: "98350 00132", name: "Reception", role: "receptionist" });
    reception = await login("9835000132");
    await call(reception, "GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("the owner connects the Facebook Page and a staff phone for hot-lead alerts", async () => {
    const page = {
      pageId: "444444444",
      pageName: "Lead API Dental",
      pageAccessToken: "EAAB-long-lived-page-token-123",
    };
    expect((await call(reception, "PUT", "/v1/lead-settings", { page })).statusCode).toBe(403);
    const res = await call(owner, "PUT", "/v1/lead-settings", { page, alertPhone: "98350 00132" });
    expect(res.json()).toEqual({
      page: { pageId: "444444444", name: "Lead API Dental" },
      datasetId: null,
      signals: { sent: 0, failed: 0, lastSentAt: null, lastError: null },
      alertPhone: "+919835000132",
    });

    // The dataset for sending lead outcomes back to Meta; the token never comes back out.
    const dataset = { datasetId: "777000111", accessToken: "capi-token-0123456789abcdef" };
    expect(
      (await call(owner, "PUT", "/v1/lead-settings", { dataset: { ...dataset, datasetId: "abc" } }))
        .statusCode,
    ).toBe(400);
    const connected = await call(owner, "PUT", "/v1/lead-settings", { dataset });
    expect(connected.json().datasetId).toBe("777000111");
    expect(connected.body).not.toContain("capi-token");
    expect((await call(owner, "PUT", "/v1/lead-settings", { dataset: null })).json().datasetId).toBeNull();
  });

  it("Meta's lead webhook: signed, routed to the clinic by Page, fetched once however often Meta retries", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=fake-verify&hub.challenge=77",
        })
      ).body,
    ).toBe("77");
    const event = { eventId: "leadgen:5551", leadgenId: "5551", pageId: "444444444", createdAt: new Date() };
    const w = leads.eventWebhook([event, { ...event, eventId: "leadgen:x", leadgenId: "x", pageId: "999" }]);
    const post = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/meta-leads",
        headers: { ...w.headers, "content-type": "application/json" } as Record<string, string>,
        payload: w.rawBody,
      });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    const fetches = jobs.jobs.filter((j) => j.task === "fetch_lead");
    expect(fetches.map((j) => j.payload)).toMatchObject([{ clinicId, leadgenId: "5551" }]);
    expect(new Set(jobs.jobs.filter((j) => j.task === "fetch_lead").map((j) => j.jobKey))).toEqual(
      new Set(["lead:5551"]),
    );
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/meta-leads",
      headers: { "x-fake-signature": "00", "content-type": "application/json" },
      payload: w.rawBody,
    });
    expect(bad.statusCode).toBe(401);
  });

  it("staff add a lead, record a call, and the list puts leads to call first", async () => {
    const created = await call(reception, "POST", "/v1/leads", {
      source: "justdial",
      name: "Ravi Verma",
      phone: "98765 33333",
      need: "implant",
      notes: "Asked about cost on JustDial",
    });
    expect(created.json().created).toBe(true);
    expect(jobs.jobs.some((j) => j.task === "lead_kickoff")).toBe(true);
    const list = (await call(reception, "GET", "/v1/leads?stage=call")).json();
    expect(list[0]).toMatchObject({ name: "Ravi Verma", score: "hot", stage: "new" });
    expect(list[0].call_due_at).toBeTruthy();
    // A hot lead also pinged the alert phone.
    const alert = (
      await db.pool.query("select to_phone, payload from outbox where purpose = 'staff_lead_alert'")
    ).rows[0];
    expect(alert.to_phone).toBe("+919835000132");

    const id = list[0].id;
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      (
        await call(reception, "POST", `/v1/leads/${id}/outcome`, {
          outcome: "callback",
          callbackAt: later,
          note: "Busy, call tomorrow",
        })
      ).statusCode,
    ).toBe(200);
    const detail = (await call(reception, "GET", `/v1/leads/${id}`)).json();
    expect(detail.activities.map((a: { kind: string }) => a.kind)).toEqual([
      "created",
      "call_task",
      "called",
      "call_task",
    ]);
    expect(detail.lead.notes).toContain("Busy, call tomorrow");
    expect(
      (await call(reception, "POST", `/v1/leads/${id}/outcome`, { outcome: "callback" })).statusCode,
    ).toBe(400);
  });

  it("funnel: rupee values only for staff who may see revenue", async () => {
    const q = "from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z";
    expect((await call(owner, "GET", `/v1/leads/funnel?${q}`)).json().totals).toMatchObject({
      leads: 1,
      revenuePaise: 0,
    });
    const staff = (await call(owner, "GET", "/v1/staff")).json();
    const rec = staff.find((s: { display_name: string }) => s.display_name === "Reception");
    await call(owner, "PATCH", `/v1/staff/${rec.id}`, { permissions: { "reports.revenue": false } });
    expect((await call(reception, "GET", `/v1/leads/funnel?${q}`)).json().totals.revenuePaise).toBeNull();
  });
});

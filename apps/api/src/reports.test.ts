import { createAdapters } from "@dentalos/adapters";
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

describe.skipIf(!hasTestDatabase)("reports API", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let owner: string;
  let reception: string;
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
      await createClinic(client, {
        name: "Report API Dental",
        owner: { name: "Dr. O", phone: "9835000161" },
      });
    } finally {
      client.release();
    }
    app = buildApp({
      pool: db.pool,
      adapters: createAdapters({
        messaging: "fake",
        telephony: "fake",
        voice: "fake",
        llm: "fake",
        payments: "fake",
        sms: "fake",
        storage: "fake",
      }),
      logger,
      version: "test",
      auth,
      jobs: new MemoryJobQueue(),
      channelKey: Buffer.alloc(32, 9),
    });
    owner = await login("9835000161");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", { phone: "98350 00162", name: "Reception", role: "receptionist" });
    reception = await login("9835000162");
    await call(reception, "GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("the owner reads the week; the nightly WhatsApp can be switched off; revenue stays with those allowed", async () => {
    const week = await call(owner, "GET", "/v1/reports?period=week&date=2030-03-12");
    expect(week.statusCode).toBe(200);
    expect(week.json()).toMatchObject({
      start: "2030-03-11",
      end: "2030-03-18",
      recovered: { totalPaise: 0, payments: [] },
      tomorrow: null,
    });
    expect((await call(owner, "GET", "/v1/reports?date=12-03-2030")).statusCode).toBe(400);

    expect((await call(owner, "GET", "/v1/reports/settings")).json()).toEqual({ nightly: true });
    await call(owner, "PUT", "/v1/reports/settings", { nightly: false });
    expect((await call(owner, "GET", "/v1/reports/settings")).json()).toEqual({ nightly: false });
    expect((await call(reception, "PUT", "/v1/reports/settings", { nightly: true })).statusCode).toBe(403);

    const staff = (await call(owner, "GET", "/v1/staff")).json();
    const rec = staff.find((s: { display_name: string }) => s.display_name === "Reception");
    await call(owner, "PATCH", `/v1/staff/${rec.id}`, { permissions: { "reports.revenue": false } });
    expect((await call(reception, "GET", "/v1/reports?date=2030-03-12")).statusCode).toBe(403);
  });

  it("setup checklist: the owner ticks steps, turns test mode on with extra numbers; reception can't", async () => {
    const list = (await call(owner, "GET", "/v1/setup")).json();
    expect(list.steps.find((s: { key: string }) => s.key === "hours")).toMatchObject({
      done: false,
      ticked: true,
    });
    const ticked = (await call(owner, "PUT", "/v1/setup/steps/hours", { done: true })).json();
    expect(ticked.steps.find((s: { key: string }) => s.key === "hours").done).toBe(true);
    expect((await call(owner, "PUT", "/v1/setup/steps/license", { done: true })).statusCode).toBe(400);
    expect((await call(owner, "PUT", "/v1/test-mode", { on: true, phones: ["98111 22233"] })).json()).toEqual(
      { on: true, phones: ["+919811122233"] },
    );
    expect((await call(owner, "GET", "/v1/setup")).json().testMode.on).toBe(true);
    expect((await call(reception, "PUT", "/v1/test-mode", { on: false })).statusCode).toBe(403);
  });
});

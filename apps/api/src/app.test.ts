import { createAdapters, type Adapters } from "@dentalos/adapters";
import { createPool } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const fakes = (): Adapters =>
  createAdapters({
    messaging: "fake",
    telephony: "fake",
    voice: "fake",
    llm: "fake",
    payments: "fake",
    sms: "fake",
    storage: "fake",
  });

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = { jwtSecret: "test-secret-that-is-long-enough-1234567890", audience: "authenticated" };

describe("config", () => {
  it("fails fast and names missing variables without printing values", () => {
    expect(() => loadConfig({ SECRET_THING: "hunter2" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ SECRET_THING: "hunter2" })).not.toThrow(/hunter2/);
  });

  it("refuses fake providers in production", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "production",
        DATABASE_URL: "postgres://x@localhost/db",
        AUTH_JWKS_URL: "https://x.supabase.co/jwks",
      }),
    ).toThrow(/fake providers are not allowed in production/);
  });

  it("requires a way to verify staff logins, and never allows dev login on staging", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x@localhost/db" })).toThrow(/AUTH_JWKS_URL/);
    expect(() =>
      loadConfig({
        APP_ENV: "staging",
        DATABASE_URL: "postgres://x@localhost/db",
        AUTH_JWT_SECRET: auth.jwtSecret,
        DEV_LOGIN: "on",
      }),
    ).toThrow(/dev login/);
  });

  it("defaults to fakes outside production", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://x@localhost/db", AUTH_JWT_SECRET: auth.jwtSecret });
    expect(config.MESSAGING_PROVIDER).toBe("fake");
    expect(config.PORT).toBe(8080);
  });
});

describe("rate limiting", () => {
  it("refuses a flood of requests from one caller with 429", async () => {
    const pool = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
    const app = buildApp({ pool, adapters: fakes(), logger, version: "test", auth, rateLimitPerMinute: 5 });
    const codes = [];
    for (let i = 0; i < 7; i++)
      codes.push((await app.inject({ url: "/v1/me", headers: { authorization: "Bearer abc" } })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect((await app.inject("/health")).statusCode).toBe(200);
    await app.close();
    await pool.end();
  });
});

describe("health without a database", () => {
  it("liveness is up, readiness is 503 when the database is unreachable", async () => {
    const pool = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
    const app = buildApp({ pool, adapters: fakes(), logger, version: "test", auth });
    expect((await app.inject("/health")).json()).toEqual({ ok: true, version: "test" });
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(503);
    expect(ready.json().components.database.ok).toBe(false);
    await app.close();
    await pool.end();
  });
});

describe.skipIf(!hasTestDatabase)("health with a database", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("is ready, reports a missing worker and unhealthy providers without failing readiness", async () => {
    const adapters = fakes();
    (adapters.voice as unknown as { support: { healthy: boolean } }).support.healthy = false;
    const app = buildApp({ pool: db.pool, adapters, logger, version: "test", auth });
    const res = await app.inject("/health/ready");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components.database.ok).toBe(true);
    expect(body.components.worker).toEqual({ ok: false, detail: "no heartbeat yet" });
    expect(body.components["provider.voice"].ok).toBe(false);
    expect(body.components["provider.messaging"].ok).toBe(true);
    await app.close();
  });

  it("sees a fresh worker heartbeat", async () => {
    await db.pool.query("insert into service_heartbeats (service) values ('worker')");
    const app = buildApp({ pool: db.pool, adapters: fakes(), logger, version: "test", auth });
    const res = await app.inject("/health/ready");
    expect(res.json().components.worker.ok).toBe(true);
    await app.close();
  });

  it("does not leak internal errors", async () => {
    const app = buildApp({ pool: db.pool, adapters: fakes(), logger, version: "test", auth });
    app.get("/boom", async () => {
      throw new Error("patient 9876543210 exploded");
    });
    const res = await app.inject("/boom");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("9876543210");
    expect(res.json().error).toBe("internal_error");
    await app.close();
  });
});

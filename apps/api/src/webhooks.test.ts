import { randomBytes } from "node:crypto";
import { createAdapters, FakeMessagingProvider } from "@dentalos/adapters";
import { connectWhatsApp, createClinic, MemoryJobQueue } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = { jwtSecret: "test-secret-that-is-long-enough-1234567890", audience: "authenticated" };

describe.skipIf(!hasTestDatabase)("WhatsApp webhook endpoint", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  const jobs = new MemoryJobQueue();
  const messaging = new FakeMessagingProvider();

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    let clinicId: string;
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Hook Dental",
        owner: { name: "Dr. H", phone: "9835000011" },
      }));
    } finally {
      client.release();
    }
    await withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, (c) =>
      connectWhatsApp(c, randomBytes(32), {
        phoneNumberId: "555000111",
        displayPhone: "0651 2000000",
        accessToken: "t",
      }),
    );
    const adapters = {
      ...createAdapters({
        messaging: "fake",
        telephony: "fake",
        voice: "fake",
        llm: "fake",
        payments: "fake",
        sms: "fake",
        storage: "fake",
      }),
      messaging,
    };
    app = buildApp({ pool: db.pool, adapters, logger, version: "test", auth, jobs, channelKey: null });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const inbound = (id: string, channelId = "555000111") =>
    messaging.inboundWebhook([
      {
        type: "inbound_message",
        eventId: `msg:${id}`,
        providerMessageId: id,
        from: "+919876543210",
        channelId,
        at: new Date(),
        content: { kind: "text", text: "Namaste" },
      },
    ]);

  it("answers Meta's subscription check", async () => {
    const ok = await app.inject(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fake-verify&hub.challenge=12345",
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    expect(
      (await app.inject("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"))
        .statusCode,
    ).toBe(403);
  });

  it("rejects unsigned or tampered deliveries", async () => {
    const hook = inbound("w1");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: hook.rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it("stores the message, routes it to the clinic by number, queues the assistant once", async () => {
    const hook = inbound("w2");
    const send = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: { ...hook.headers, "content-type": "application/json" },
        payload: hook.rawBody,
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(jobs.jobs.filter((j) => j.task === "process_inbound")).toHaveLength(1);
    // Answered one at a time per chat, in order.
    expect(jobs.jobs.find((j) => j.task === "process_inbound")?.queueName).toMatch(/^chat:[0-9a-f-]{36}$/);
    const { rows } = await db.pool.query(
      "select m.body, c.phone from messages m join conversations c on c.id = m.conversation_id",
    );
    expect(rows).toEqual([{ body: "Namaste", phone: "+919876543210" }]);
  });

  it("ignores events for a number no clinic has connected", async () => {
    const hook = inbound("w3", "999");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { ...hook.headers, "content-type": "application/json" },
      payload: hook.rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect((await db.pool.query("select count(*)::int as n from messages")).rows[0].n).toBe(1);
  });
});

import { randomBytes } from "node:crypto";
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

describe.skipIf(!hasTestDatabase)("staff inbox, tasks and WhatsApp settings", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let clinicId: string;
  let token: string;
  const jobs = new MemoryJobQueue();
  const call = (method: string, url: string, payload?: unknown) =>
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
        name: "Inbox Dental",
        owner: { name: "Dr. I", phone: "9835000031" },
      }));
    } finally {
      client.release();
    }
    const adapters = createAdapters({
      messaging: "fake",
      telephony: "fake",
      voice: "fake",
      llm: "fake",
      payments: "fake",
      sms: "fake",
      storage: "fake",
    });
    app = buildApp({
      pool: db.pool,
      adapters,
      logger,
      version: "test",
      auth,
      jobs,
      channelKey: randomBytes(32),
    });
    token = (
      await (
        await app.inject({ method: "POST", url: "/v1/dev/login", payload: { phone: "9835000031" } })
      ).json()
    ).token;
    await call("GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function conversation(lastInboundMinutesAgo: number | null) {
    const phone = `+9190000${Math.floor(10000 + Math.random() * 89999)}`;
    const { rows } = await db.pool.query(
      `insert into conversations (clinic_id, channel, phone, last_inbound_at, last_message_at, last_preview, unread_count)
       values ($1, 'whatsapp', $2, $3, now(), 'RCT kitna ka hai?', 1) returning id`,
      [
        clinicId,
        phone,
        lastInboundMinutesAgo === null ? null : new Date(Date.now() - lastInboundMinutesAgo * 60_000),
      ],
    );
    await db.pool.query(
      "insert into messages (clinic_id, conversation_id, direction, author, kind, body, status) values ($1, $2, 'in', 'patient', 'text', 'RCT kitna ka hai?', 'received')",
      [clinicId, rows[0].id],
    );
    return rows[0].id as string;
  }

  it("lists conversations and opens a thread, marking it read", async () => {
    const id = await conversation(5);
    const list = (await call("GET", "/v1/inbox")).json();
    expect(list.find((c: { id: string }) => c.id === id)).toMatchObject({
      unread_count: 1,
      last_preview: "RCT kitna ka hai?",
    });
    const thread = (await call("GET", `/v1/inbox/${id}`)).json();
    expect(thread.conversation.windowOpen).toBe(true);
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual(["RCT kitna ka hai?"]);
    expect(thread.conversation.state).toBeUndefined();
    expect(
      (await call("GET", "/v1/inbox?filter=unread")).json().some((c: { id: string }) => c.id === id),
    ).toBe(false);
  });

  it("takeover and release switch the assistant off and on", async () => {
    const id = await conversation(5);
    await call("POST", `/v1/inbox/${id}/takeover`);
    expect((await db.pool.query("select mode from conversations where id = $1", [id])).rows[0].mode).toBe(
      "human",
    );
    await call("POST", `/v1/inbox/${id}/release`);
    expect((await db.pool.query("select mode from conversations where id = $1", [id])).rows[0].mode).toBe(
      "bot",
    );
  });

  it("a staff reply takes over the thread and is queued for sending", async () => {
    const id = await conversation(5);
    const res = await call("POST", `/v1/inbox/${id}/reply`, {
      text: "Namaste ji, doctor sahab 5 baje milenge.",
    });
    expect(res.statusCode).toBe(200);
    expect(
      jobs.jobs.some((j) => j.task === "send_outbox" && j.payload.outboxId === res.json().outboxId),
    ).toBe(true);
    expect((await db.pool.query("select mode from conversations where id = $1", [id])).rows[0].mode).toBe(
      "human",
    );
    const thread = (await call("GET", `/v1/inbox/${id}`)).json();
    expect(thread.messages.at(-1)).toMatchObject({
      author: "staff",
      status: "queued",
      body: "Namaste ji, doctor sahab 5 baje milenge.",
    });
  });

  it("refuses a free-text reply outside WhatsApp's 24-hour window", async () => {
    const id = await conversation(60 * 25);
    const res = await call("POST", `/v1/inbox/${id}/reply`, { text: "Hello" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("window_closed");
  });

  it("lists open tasks by priority and marks them done", async () => {
    await db.pool.query(
      "insert into tasks (clinic_id, kind, priority, title, created_by) values ($1, 'callback', 'normal', 'Call back', 'bot'), ($1, 'emergency', 'critical', 'Swelling', 'bot')",
      [clinicId],
    );
    const tasks = (await call("GET", "/v1/tasks")).json();
    expect(tasks.map((t: { priority: string }) => t.priority).slice(0, 2)).toEqual(["critical", "normal"]);
    expect((await call("POST", `/v1/tasks/${tasks[0].id}/done`)).json()).toEqual({ ok: true });
    expect((await call("GET", "/v1/tasks")).json()).toHaveLength(1);
  });

  it("connects WhatsApp (token stored encrypted) and registers the standard templates", async () => {
    const res = await call("PUT", "/v1/whatsapp", {
      phoneNumberId: "123456789",
      displayPhone: "0651 2345678",
      accessToken: "EAAG-very-secret-token-value",
    });
    expect(res.json()).toMatchObject({
      connected: true,
      phoneNumberId: "123456789",
      displayPhone: "+916512345678",
    });
    const status = (await call("GET", "/v1/whatsapp")).json();
    expect(status.templates).toHaveLength(14);
    expect(
      (await db.pool.query("select credentials_encrypted from clinic_channels")).rows[0]
        .credentials_encrypted,
    ).not.toContain("EAAG");
    const approved = await call("PATCH", `/v1/whatsapp/templates/${status.templates[0].id}`, {
      metaStatus: "approved",
    });
    expect(approved.json().meta_status).toBe("approved");
  });
});

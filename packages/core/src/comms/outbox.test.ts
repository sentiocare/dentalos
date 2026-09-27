import { randomBytes } from "node:crypto";
import { FakeMessagingProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectWhatsApp, getWhatsAppChannel } from "./channels";
import { ensureConversation, logMessage } from "./conversations";
import { enqueueMessage, processOutbox, type OutboundMessage } from "./outbox";

const KEY = randomBytes(32);
const PATIENT = "+919876543210";
const MORNING = new Date("2026-10-13T11:00:00+05:30");

describe.skipIf(!hasTestDatabase)("outbox", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  let messaging: FakeMessagingProvider;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "system", role: "system" }, fn);
  const deps = (now = MORNING) => ({
    messaging,
    channel: (cl: PoolClient) => getWhatsAppChannel(cl, KEY),
    now: () => now,
  });

  let n = 0;
  const reminder = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    to: PATIENT,
    category: "transactional",
    purpose: "reminder_day_before",
    payload: {
      kind: "template",
      purpose: "reminder_day_before",
      language: "hi",
      params: ["Ramesh ji", "Test Dental", "मंगलवार, 13 अक्टूबर, शाम 5 बजे", "Dr. Sharma"],
      buttonPayloads: ["confirm:a1", "reschedule:a1"],
    },
    dedupeKey: `k${++n}`,
    notBefore: new Date("2026-10-13T00:00:00+05:30"),
    ...over,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
    await run((cl) =>
      connectWhatsApp(cl, KEY, {
        phoneNumberId: "109876543210",
        displayPhone: "0651 2345678",
        accessToken: "EAAG-secret",
      }),
    );
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    messaging = new FakeMessagingProvider();
    await db.pool.query("delete from opt_outs; update conversations set last_inbound_at = null");
  });

  it("stores the WhatsApp token encrypted, never in plain text", async () => {
    const { rows } = await db.pool.query("select credentials_encrypted from clinic_channels");
    expect(rows[0].credentials_encrypted).not.toContain("EAAG-secret");
    expect((await run((cl) => getWhatsAppChannel(cl, KEY)))?.accessToken).toBe("EAAG-secret");
  });

  it("the same dedupe key is queued only once", async () => {
    const m = reminder({ dedupeKey: "appt:a1:reminder" });
    expect(await run((cl) => enqueueMessage(cl, m))).toBeTruthy();
    expect(await run((cl) => enqueueMessage(cl, m))).toBeNull();
  });

  it("outside the 24-hour window uses the approved template, with its buttons", async () => {
    await db.pool.query(
      "insert into message_templates (clinic_id, purpose, name, language, category, body, meta_status) values ($1,'reminder_day_before','sentio_reminder_day_before','hi','utility','x','approved')",
      [c.clinicId],
    );
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    expect(await run((cl) => processOutbox(cl, id, deps()))).toMatchObject({ status: "sent" });
    expect(messaging.sent[0]).toMatchObject({
      kind: "template",
      templateName: "sentio_reminder_day_before",
      buttonPayloads: ["confirm:a1", "reschedule:a1"],
      channelId: "109876543210",
    });
    const logged = await db.pool.query(
      "select status, template_name, body from messages where template_name is not null",
    );
    expect(logged.rows[0].body).toContain("कल");
  });

  it("inside the window sends the same words as a normal message with reply buttons", async () => {
    await run(async (cl) => {
      const conv = await ensureConversation(cl, PATIENT);
      await logMessage(cl, {
        conversationId: conv.id,
        direction: "in",
        author: "patient",
        kind: "text",
        body: "hi",
        status: "received",
        at: new Date(MORNING.getTime() - 3600_000),
      });
    });
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    await run((cl) => processOutbox(cl, id, deps()));
    expect(messaging.sent[0]).toMatchObject({
      kind: "buttons",
      buttons: [
        { id: "confirm:a1", title: "पक्का करें" },
        { id: "reschedule:a1", title: "समय बदलें" },
      ],
    });
  });

  it("without an approved template, outside the window, the message is blocked and visible to staff", async () => {
    const id = (await run((cl) =>
      enqueueMessage(
        cl,
        reminder({
          payload: { kind: "template", purpose: "missed_call", language: "en", params: ["Test Dental"] },
        }),
      ),
    ))!;
    expect(await run((cl) => processOutbox(cl, id, deps()))).toEqual({
      status: "blocked",
      reason: "outside_window_no_template",
    });
    expect(messaging.sent).toHaveLength(0);
    const { rows } = await db.pool.query("select status, error from messages where status = 'blocked'");
    expect(rows.at(-1)).toEqual({ status: "blocked", error: "outside_window_no_template" });
  });

  it("waits for the morning instead of messaging late at night", async () => {
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    const out = await run((cl) => processOutbox(cl, id, deps(new Date("2026-10-13T23:00:00+05:30"))));
    expect(out).toEqual({
      status: "retry",
      at: new Date("2026-10-14T07:00:00+05:30"),
      reason: "quiet_hours",
    });
    expect(messaging.sent).toHaveLength(0);
  });

  it("respects STOP", async () => {
    await db.pool.query(
      "insert into opt_outs (clinic_id, phone, channel, category, source) values ($1,$2,'whatsapp','all','stop')",
      [c.clinicId, PATIENT],
    );
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    expect(await run((cl) => processOutbox(cl, id, deps()))).toEqual({
      status: "blocked",
      reason: "opted_out",
    });
  });

  it("retries temporary failures with backoff and gives up on permanent ones", async () => {
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    messaging.support.failNext("131056", true);
    const first = await run((cl) => processOutbox(cl, id, deps()));
    expect(first).toMatchObject({ status: "retry", reason: "fake-messaging:131056" });
    expect(await run((cl) => processOutbox(cl, id, deps()))).toMatchObject({ status: "skipped" }); // not due yet
    const later = new Date(MORNING.getTime() + 10 * 60_000);
    expect(await run((cl) => processOutbox(cl, id, deps(later)))).toMatchObject({ status: "sent" });

    const id2 = (await run((cl) => enqueueMessage(cl, reminder())))!;
    messaging.support.failNext("131026", false);
    expect(await run((cl) => processOutbox(cl, id2, deps()))).toEqual({
      status: "failed",
      reason: "fake-messaging:131026",
    });
  });

  it("five workers racing on one message send it exactly once", async () => {
    const id = (await run((cl) => enqueueMessage(cl, reminder())))!;
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => run((cl) => processOutbox(cl, id, deps()))),
    );
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(messaging.sent).toHaveLength(1);
  });
});

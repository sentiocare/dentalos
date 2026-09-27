import { randomBytes } from "node:crypto";
import { FakeMessagingProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import { bookDirect, cancelAppointment, moveAppointment } from "../scheduling/service";
import { connectWhatsApp, getWhatsAppChannel } from "./channels";
import { processOutbox } from "./outbox";
import { planAppointmentMessages } from "./reminders";

const KEY = randomBytes(32);
const at = (s: string) => new Date(`${s}+05:30`);
// Monday 7 Jan 2030, 10:00 IST.
const NOW = at("2030-01-07T10:00:00");

describe.skipIf(!hasTestDatabase)("appointment messages", () => {
  let db: TestDatabase;
  let clinicId: string;
  let doctorId: string;
  let chairId: string;
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);
  const outbox = (appointmentId: string) =>
    db.pool
      .query(
        "select purpose, not_before, status, payload from outbox where appointment_id = $1 order by created_at, purpose",
        [appointmentId],
      )
      .then((r) => r.rows);

  async function book(start: string, source: "staff" | "import" = "staff") {
    const phone = `+91900001${String(1000 + ++n)}`;
    return run(async (c) => {
      const p = await createPatient(c, { name: `Patient ${n}`, phone, languagePref: "hinglish" });
      const { appointment } = await bookDirect(c, {
        patientId: p.id,
        doctorId,
        chairId,
        startsAt: at(start),
        endsAt: new Date(at(start).getTime() + 30 * 60_000),
        acknowledgeWarnings: true,
        source,
        now: NOW,
      });
      await c.query("update appointments set created_at = $2 where id = $1", [appointment.id, NOW]);
      return { ...appointment, phone };
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Remind Dental",
        owner: { name: "Dr. R", phone: "9835000021" },
      }));
      doctorId = (
        await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. Rao') returning id", [
          clinicId,
        ])
      ).rows[0].id;
      chairId = (await client.query("select id from chairs where clinic_id = $1", [clinicId])).rows[0].id;
      await client.query(
        "insert into message_templates (clinic_id, purpose, name, language, category, body, meta_status) select $1, p, 'sentio_' || p, 'hi', 'utility', 'x', 'approved' from unnest(array['booking_confirmation','reminder_day_before','reminder_same_day','appointment_rescheduled','appointment_cancelled']) p",
        [clinicId],
      );
    } finally {
      client.release();
    }
    await run((c) =>
      connectWhatsApp(c, KEY, { phoneNumberId: "7770001", displayPhone: "0651 2000001", accessToken: "t" }),
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("queues a confirmation now, a day-before reminder at 17:00 with buttons, and one 2 hours before", async () => {
    const a = await book("2030-01-10T11:00:00");
    await run((c) => planAppointmentMessages(c, NOW));
    const rows = await outbox(a.id);
    expect(rows.map((r) => [r.purpose, r.not_before.toISOString()])).toEqual([
      ["booking_confirmation", expect.any(String)],
      ["reminder_day_before", at("2030-01-09T17:00:00").toISOString()],
      ["reminder_same_day", at("2030-01-10T09:00:00").toISOString()],
    ]);
    expect(rows[0].payload.params[2]).toBe("गुरुवार, 10 जनवरी, सुबह 11 बजे");
    expect(rows[1].payload.buttonPayloads).toEqual([`confirm:${a.id}`, `reschedule:${a.id}`]);
    // Running again adds nothing.
    await run((c) => planAppointmentMessages(c, NOW));
    expect(await outbox(a.id)).toHaveLength(3);
  });

  it("a moved appointment gets a reschedule notice and fresh reminders; the old reminders are dropped when due", async () => {
    const a = await book("2030-01-11T11:00:00");
    await run((c) => planAppointmentMessages(c, NOW));
    await run((c) =>
      moveAppointment(c, a.id, { startsAt: at("2030-01-12T12:00:00"), acknowledgeWarnings: true, now: NOW }),
    );
    await run((c) => planAppointmentMessages(c, NOW));
    const rows = await outbox(a.id);
    expect(rows.map((r) => r.purpose)).toEqual([
      "booking_confirmation",
      "reminder_day_before",
      "reminder_same_day",
      "appointment_rescheduled",
      "reminder_day_before",
      "reminder_same_day",
    ]);
    const stale = (
      await db.pool.query(
        "select id from outbox where appointment_id = $1 and purpose = 'reminder_day_before' order by created_at limit 1",
        [a.id],
      )
    ).rows[0].id;
    const messaging = new FakeMessagingProvider();
    const outcome = await run((c) =>
      processOutbox(c, stale, {
        messaging,
        channel: (cl) => getWhatsAppChannel(cl, KEY),
        now: () => at("2030-01-10T17:05:00"),
      }),
    );
    expect(outcome).toEqual({ status: "skipped", reason: "appointment_changed" });
    expect(messaging.sent).toHaveLength(0);
  });

  it("a cancelled appointment gets one cancellation notice", async () => {
    const a = await book("2030-01-14T11:00:00");
    await run((c) => planAppointmentMessages(c, NOW));
    await run((c) => cancelAppointment(c, a.id, "doctor unavailable"));
    await run((c) => planAppointmentMessages(c, NOW));
    await run((c) => planAppointmentMessages(c, NOW));
    const purposes = (await outbox(a.id)).map((r) => r.purpose);
    expect(purposes.filter((p) => p === "appointment_cancelled")).toHaveLength(1);
  });

  it("imported appointments get reminders but no surprise 'booked' message", async () => {
    const a = await book("2030-01-15T11:00:00", "import");
    await run((c) => planAppointmentMessages(c, NOW));
    expect((await outbox(a.id)).map((r) => r.purpose)).toEqual(["reminder_day_before", "reminder_same_day"]);
  });

  it("no day-before reminder when the booking was made after that time", async () => {
    const lateNow = at("2030-01-07T19:00:00");
    const a = await book("2030-01-08T12:00:00");
    await db.pool.query("update appointments set created_at = $2 where id = $1", [a.id, lateNow]);
    await run((c) => planAppointmentMessages(c, lateNow));
    expect((await outbox(a.id)).map((r) => r.purpose)).toEqual(["booking_confirmation", "reminder_same_day"]);
  });

  it("sends the reminder as the approved template, and not to a patient who sent STOP", async () => {
    const a = await book("2030-01-16T11:00:00");
    await run((c) => planAppointmentMessages(c, NOW));
    const reminder = (
      await db.pool.query(
        "select id from outbox where appointment_id = $1 and purpose = 'reminder_day_before'",
        [a.id],
      )
    ).rows[0].id;
    const messaging = new FakeMessagingProvider();
    const due = at("2030-01-15T17:00:00");
    await run((c) =>
      processOutbox(c, reminder, { messaging, channel: (cl) => getWhatsAppChannel(cl, KEY), now: () => due }),
    );
    expect(messaging.sent[0]).toMatchObject({
      kind: "template",
      templateName: "sentio_reminder_day_before",
      to: a.phone,
    });

    const b = await book("2030-01-17T11:00:00");
    await db.pool.query(
      "insert into opt_outs (clinic_id, phone, channel, category, source) values ($1, $2, 'whatsapp', 'all', 'stop')",
      [clinicId, b.phone],
    );
    await run((c) => planAppointmentMessages(c, NOW));
    const r2 = (
      await db.pool.query(
        "select id from outbox where appointment_id = $1 and purpose = 'reminder_day_before'",
        [b.id],
      )
    ).rows[0].id;
    expect(
      await run((c) =>
        processOutbox(c, r2, {
          messaging,
          channel: (cl) => getWhatsAppChannel(cl, KEY),
          now: () => at("2030-01-16T17:00:00"),
        }),
      ),
    ).toEqual({
      status: "blocked",
      reason: "opted_out",
    });
  });
});

import { bookDirect, createPatient } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallerSimulator, setupVoiceClinic } from "../testing/voice-harness";
import { checkConfirmationCall } from "./outbound";

// Tuesday 8 January 2030, 19:00 IST: the evening before the appointments.
const EVENING = new Date("2030-01-08T19:00:00+05:30");

describe.skipIf(!hasTestDatabase)("outbound confirmation calls (Phase 4)", () => {
  let db: TestDatabase;
  let clinicId: string;
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);
  async function booked(name: string, startAt?: string) {
    const phone = `+9190006${String(10000 + ++n)}`;
    // Each appointment gets its own slot: 11:00, then 17:00, 17:40…
    const start =
      startAt ??
      (n === 1
        ? "2030-01-09T11:00:00+05:30"
        : new Date(Date.parse("2030-01-09T17:00:00+05:30") + (n - 2) * 40 * 60_000).toISOString());
    return run(async (c) => {
      const p = await createPatient(c, { name, phone, languagePref: "hinglish" });
      const doctor = (await c.query("select id from doctors limit 1")).rows[0].id;
      const chair = (await c.query("select id from chairs limit 1")).rows[0].id;
      const { appointment } = await bookDirect(c, {
        patientId: p.id,
        doctorId: doctor,
        chairId: chair,
        startsAt: new Date(start),
        endsAt: new Date(new Date(start).getTime() + 30 * 60_000),
        acknowledgeWarnings: true,
      });
      return { patient: p, phone, appointment };
    });
  }
  const status = (id: string) =>
    db.pool.query("select status from appointments where id = $1", [id]).then((r) => r.rows[0].status);

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ clinicId } = await setupVoiceClinic(db.pool));
    await run((c) =>
      c.query('update clinics set settings = settings || \'{"voice": {"outboundFlowId": "123456"}}\''),
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("checks every rule before dialling", async () => {
    const { appointment, phone } = await booked("Rules Check");
    expect(await checkConfirmationCall(db.pool, clinicId, appointment.id, EVENING)).toMatchObject({
      ok: true,
      phone,
      flowId: "123456",
    });
    expect(
      await checkConfirmationCall(db.pool, clinicId, appointment.id, new Date("2030-01-08T21:00:00+05:30")),
    ).toEqual({ ok: false, reason: "outside_hours" });
    expect(
      await checkConfirmationCall(db.pool, clinicId, appointment.id, new Date("2030-01-09T10:30:00+05:30")),
    ).toEqual({ ok: false, reason: "too_late" });
    // Test mode: no AI calls to patients while the clinic is being set up.
    await db.pool.query(
      `update clinics set settings = settings || '{"testMode": {"on": true, "phones": []}}' where id = $1`,
      [clinicId],
    );
    expect(await checkConfirmationCall(db.pool, clinicId, appointment.id, EVENING)).toEqual({
      ok: false,
      reason: "test_mode",
    });
    await db.pool.query(`update clinics set settings = settings - 'testMode' where id = $1`, [clinicId]);
    await db.pool.query(
      "insert into opt_outs (clinic_id, phone, channel, category, source) values ($1, $2, 'voice', 'all', 'test')",
      [clinicId, phone],
    );
    expect(await checkConfirmationCall(db.pool, clinicId, appointment.id, EVENING)).toEqual({
      ok: false,
      reason: "opted_out",
    });
    const other = await booked("Already Confirmed");
    await db.pool.query("update appointments set status = 'confirmed' where id = $1", [other.appointment.id]);
    expect(await checkConfirmationCall(db.pool, clinicId, other.appointment.id, EVENING)).toEqual({
      ok: false,
      reason: "not_booked",
    });
  });

  it("the patient confirms: the appointment is confirmed and the call ends", async () => {
    const { appointment, patient, phone } = await booked("Sunil Gupta");
    const call = new CallerSimulator(db.pool, phone, EVENING);
    const hello = (await call.answerConfirmationCall(appointment.id, clinicId, patient.id)).join(" ");
    expect(hello).toMatch(/डिजिटल असिस्टेंट बोल रही हूँ/);
    expect(hello).toMatch(/Sunil Gupta का appointment कल शाम/);
    await call.say("haan ji aa jaunga", "hi-IN");
    expect(call.last!.end).toEqual({ kind: "hangup" });
    expect(await status(appointment.id)).toBe("confirmed");
    expect((await call.record()).outcome).toBe("confirmed");
  });

  it("the patient can't come: moves it to another time on the same call", async () => {
    const { appointment, patient, phone } = await booked("Neha Jain");
    const call = new CallerSimulator(db.pool, phone, EVENING);
    await call.answerConfirmationCall(appointment.id, clinicId, patient.id);
    expect((await call.say("nahi", "hi-IN")).join(" ")).toMatch(/समय बदल दूँ/);
    expect((await call.say("time badal do", "hi-IN")).join(" ")).toMatch(/कौन-सा दिन/);
    await call.say("parson shaam ko", "hi-IN");
    await call.say("pehla", "hi-IN");
    await call.say("haan", "hi-IN");
    expect((await call.record()).outcome).toBe("rescheduled");
    const moved = (await db.pool.query("select starts_at from appointments where id = $1", [appointment.id]))
      .rows[0].starts_at;
    expect(moved.toISOString().slice(0, 10)).toBe("2030-01-10");
  });

  it("'don't call me' is recorded at once and the call ends politely", async () => {
    const { appointment, patient, phone } = await booked("Pooja Rani");
    const call = new CallerSimulator(db.pool, phone, EVENING);
    await call.answerConfirmationCall(appointment.id, clinicId, patient.id);
    expect((await call.say("mujhe call mat karo", "hi-IN")).join(" ")).toMatch(/अपने आप वाली कॉल नहीं/);
    expect(call.last!.end).toEqual({ kind: "hangup" });
    const opt = (await db.pool.query("select channel, category from opt_outs where phone = $1", [phone]))
      .rows;
    expect(opt).toEqual([{ channel: "voice", category: "all" }]);
    expect(await checkConfirmationCall(db.pool, clinicId, appointment.id, EVENING)).toEqual({
      ok: false,
      reason: "opted_out",
    });
  });

  it("an emergency on a confirmation call is still handled first", async () => {
    const { appointment, patient, phone } = await booked("Emergency Caller");
    const call = new CallerSimulator(db.pool, phone, EVENING);
    await call.answerConfirmationCall(appointment.id, clinicId, patient.id);
    await call.say("mera gaal bahut sooj gaya hai aur saans lene mein dikkat hai", "hi-IN");
    expect(call.last!.end).toEqual({ kind: "transfer", to: "emergency" });
  });
});

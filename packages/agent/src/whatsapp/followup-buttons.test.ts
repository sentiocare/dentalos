import { createPatient, createEstimate, createTreatmentPlan, patientPlans } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastButtons, PatientSimulator, setupWhatsAppClinic } from "../testing/harness";

// Monday 7 January 2030, 09:00 IST.
const MONDAY = new Date("2030-01-07T09:00:00+05:30");
const text = (m: { kind: string } & Record<string, unknown>) => String(m.text ?? m.body ?? "");

describe.skipIf(!hasTestDatabase)("WhatsApp: answering follow-up messages (Phase 4)", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, fn);
  /** An existing patient of the clinic, who has never used the WhatsApp assistant. */
  const existing = async (name: string) => {
    const phone = `+9190005${String(10000 + ++n)}`;
    const p = await run((c) => createPatient(c, { name, phone, languagePref: "en" }));
    return { patient: p, sim: new PatientSimulator(db.pool, clinic, phone, new Date(MONDAY)) };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupWhatsAppClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("'Book now' on a next-sitting reminder books that sitting and links it to the plan", async () => {
    const { patient, sim } = await existing("Kiran Das");
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'rct'")).rows[0].id,
    );
    await run((c) =>
      createTreatmentPlan(c, {
        patientId: patient.id,
        templateId: tpl,
        startDate: "2030-01-08",
        status: "accepted",
        now: MONDAY,
      }),
    );
    const step = (await run((c) => patientPlans(c, patient.id)))[0]!.steps[0]!;

    const sent = await sim.tap(`book_step:${step.id}`, "Book now");
    // The privacy notice is shown once, for information; then the times.
    expect(text(sent[0]!)).toContain("Sentio Care");
    expect(text(sent.at(-1)!)).toMatch(/Root canal/);
    const slot = lastButtons(sent)[0]!;
    await sim.tap(slot.id, slot.title);
    const done = await sim.tap("yes_book", "Yes, book it");
    expect(text(done[0]!)).toMatch(/booked/i);
    const view = (await run((c) => patientPlans(c, patient.id)))[0]!;
    expect(view.steps[0]!.status).toBe("scheduled");
    expect(view.status).toBe("in_progress");
    const consent = await db.pool.query("select captured_via from consents where phone = $1", [sim.phone]);
    expect(consent.rows).toEqual([{ captured_via: "replied_to_clinic_message" }]);
  });

  it("another number cannot book someone else's sitting", async () => {
    const { patient } = await existing("Owner Of Plan");
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'rct'")).rows[0].id,
    );
    await run((c) =>
      createTreatmentPlan(c, { patientId: patient.id, templateId: tpl, status: "accepted", now: MONDAY }),
    );
    const step = (await run((c) => patientPlans(c, patient.id)))[0]!.steps[0]!;
    const { sim: stranger } = await existing("Stranger");
    const sent = await stranger.tap(`book_step:${step.id}`, "Book now");
    expect(sent.map(text).join(" ")).not.toMatch(/Root canal/);
  });

  it("'Go ahead' on an estimate accepts it and offers the first sitting", async () => {
    const { patient, sim } = await existing("Lata Singh");
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'extraction'")).rows[0].id,
    );
    const plan = await run((c) =>
      createTreatmentPlan(c, { patientId: patient.id, templateId: tpl, now: MONDAY }),
    );
    const e = await run((c) =>
      createEstimate(c, {
        patientId: patient.id,
        planId: plan.id,
        items: [{ label: "Extraction", qty: 1, amountPaise: 150000 }],
      }),
    );
    await run((c) => c.query("update estimates set status = 'sent', sent_at = now() where id = $1", [e.id]));
    const sent = await sim.tap(`estimate_ok:${e.id}`, "Go ahead");
    expect(sent.map(text).join(" ")).toMatch(/first sitting/);
    expect((await db.pool.query("select status from estimates where id = $1", [e.id])).rows[0].status).toBe(
      "accepted",
    );
    expect((await run((c) => patientPlans(c, patient.id)))[0]!.status).toBe("accepted");
  });

  it("check-in answers: fine is thanked; pain and help become tasks for the doctor", async () => {
    const { patient, sim } = await existing("Ravi Kumar");
    const appt = await run(async (c) => {
      const chair = (await c.query("select id from chairs limit 1")).rows[0].id;
      const doctor = (await c.query("select id from doctors limit 1")).rows[0].id;
      return (
        await c.query(
          `insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at, status)
           values (app.current_clinic_id(), (select id from branches limit 1), $1, $2, $3, '2030-01-06T11:00:00+05:30', '2030-01-06T11:30:00+05:30', 'completed') returning id`,
          [patient.id, doctor, chair],
        )
      ).rows[0].id;
    });
    expect(text((await sim.tap(`checkin:${appt}:ok`, "Feeling fine")).at(-1)!)).toMatch(/Glad to hear/);
    expect(text((await sim.tap(`checkin:${appt}:pain`, "Some pain")).at(-1)!)).toMatch(/let the doctor know/);
    await sim.tap(`checkin:${appt}:help`, "Need help");
    const tasks = (
      await db.pool.query("select kind, priority from tasks where appointment_id = $1 order by priority", [
        appt,
      ])
    ).rows;
    expect(tasks).toEqual([
      { kind: "callback", priority: "high" },
      { kind: "followup", priority: "normal" },
    ]);

    // A free-text reply to a recent check-in with a trigger word also reaches the doctor.
    const other = await existing("Meera");
    await db.pool.query(
      `insert into outbox (clinic_id, channel, to_phone, patient_id, appointment_id, category, purpose, payload, dedupe_key, status, sent_at)
       values ($1, 'whatsapp', $2, $3, $4, 'transactional', 'followup_aftercare_checkin', '{"kind": "template", "purpose": "checkin"}', 'ci-test', 'sent', $5)`,
      [clinic.clinicId, other.sim.phone, other.patient.id, appt, MONDAY],
    );
    await db.pool.query("update appointments set patient_id = $2 where id = $1", [appt, other.patient.id]);
    const reply = await other.sim.say("thoda dard hai aur halka khoon aa raha hai");
    expect(reply.map(text).join(" ")).toMatch(/let the doctor know|doctor ko bata diya/);
    expect(
      (await db.pool.query("select priority from tasks where dedupe_key = $1", [`checkin_text:${appt}`]))
        .rows,
    ).toEqual([{ priority: "high" }]);
  });
});

import { FakeStorageProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { MemoryJobQueue } from "../jobs";
import { createPatient } from "../patients/service";
import { bookDirect, setAppointmentStatus } from "../scheduling/service";
import { createEstimate, decideEstimate, sendEstimate } from "./estimates";
import {
  advanceFollowups,
  listFollowups,
  nextStepTime,
  planFollowups,
  saveLadder,
  stopFollowup,
  windowInWords,
} from "./followups";
import { createTreatmentPlan, patientPlans } from "./treatments";

const at = (s: string) => new Date(`${s}+05:30`);

describe("follow-up timing helpers", () => {
  it("moves a step to the next occurrence of its local time", () => {
    const tz = "Asia/Kolkata";
    expect(
      nextStepTime(
        at("2030-01-07T11:00:00"),
        { afterHours: 12, atLocalTime: "10:00", action: "whatsapp" },
        tz,
      ),
    ).toEqual(at("2030-01-08T10:00:00"));
    expect(
      nextStepTime(
        at("2030-01-07T18:00:00"),
        { afterHours: 12, atLocalTime: "10:00", action: "whatsapp" },
        tz,
      ),
    ).toEqual(at("2030-01-08T10:00:00"));
    expect(nextStepTime(at("2030-01-07T18:00:00"), { afterHours: 2, action: "staff_task" }, tz)).toEqual(
      at("2030-01-07T20:00:00"),
    );
  });

  it("says a treatment window in words", () => {
    expect(windowInWords("2030-01-12", "2030-01-16", "en")).toBe("between 12 and 16 January");
    expect(windowInWords("2030-01-30", "2030-02-03", "en")).toBe("between 30 January and 3 February");
    expect(windowInWords("2030-01-12", "2030-01-16", "hi")).toBe("12–16 जनवरी के बीच");
  });
});

describe.skipIf(!hasTestDatabase)("follow-up engine", () => {
  let db: TestDatabase;
  let clinicId: string;
  let doctorId: string;
  let chairId: string;
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);
  const plan = (now: Date) => run((c) => planFollowups(c, now));
  const step = (now: Date) => run((c) => advanceFollowups(c, now));
  const patient = (name = `FU Patient ${++n}`) =>
    run((c) => createPatient(c, { name, phone: `+9190004${String(10000 + n)}`, languagePref: "en" }));
  const book = (
    patientId: string,
    start: string,
    extra: { procedure?: string; step?: string; createdAt?: string } = {},
  ) =>
    run(async (c) => {
      const procedureTypeId = extra.procedure
        ? (await c.query("select id from procedure_types where code = $1", [extra.procedure])).rows[0].id
        : null;
      const { appointment } = await bookDirect(c, {
        patientId,
        doctorId,
        chairId,
        procedureTypeId,
        startsAt: at(start),
        endsAt: new Date(at(start).getTime() + 30 * 60_000),
        acknowledgeWarnings: true,
        treatmentStepId: extra.step,
      });
      if (extra.createdAt)
        await c.query("update appointments set created_at = $2 where id = $1", [
          appointment.id,
          at(extra.createdAt),
        ]);
      return appointment;
    });
  const runsFor = (patientId: string) =>
    db.pool
      .query(
        "select kind, status, step, next_at from followup_runs where patient_id = $1 order by started_at",
        [patientId],
      )
      .then((r) => r.rows);
  const messagesTo = (phone: string) =>
    db.pool
      .query(
        "select purpose, payload, not_before from outbox where to_phone = $1 and purpose like 'followup_%' order by created_at",
        [phone],
      )
      .then((r) => r.rows);

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Follow Dental",
        owner: { name: "Dr. F", phone: "9835000071" },
      }));
      doctorId = (
        await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. F') returning id", [
          clinicId,
        ])
      ).rows[0].id;
      chairId = (await client.query("select id from chairs where clinic_id = $1", [clinicId])).rows[0].id;
      await client.query("update clinics set default_language = 'en' where id = $1", [clinicId]);
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("treatment continuity: reminds before the next sitting's window, twice, then a staff task", async () => {
    const p = await patient("Asha Rao");
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'rct'")).rows[0].id,
    );
    await run((c) =>
      createTreatmentPlan(c, {
        patientId: p.id,
        doctorId,
        templateId: tpl,
        startDate: "2030-01-07",
        status: "accepted",
      }),
    );
    const first = (await run((c) => patientPlans(c, p.id)))[0]!.steps[0]!;
    // The first sitting is already due: a run starts for it too, but booking it ends that run.
    const a = await book(p.id, "2030-01-07T11:00:00", { step: first.id, procedure: "rct_sitting" });
    await run((c) => setAppointmentStatus(c, a.id, "completed"));

    // Sitting 2 window: 10–14 Jan. Nothing before the day before it opens.
    await plan(at("2030-01-07T12:00:00"));
    expect((await runsFor(p.id)).filter((r) => r.kind === "treatment_continuity")).toEqual([]);
    await plan(at("2030-01-09T08:00:00"));
    const runs = await runsFor(p.id);
    expect(runs).toEqual([
      { kind: "treatment_continuity", status: "active", step: 0, next_at: at("2030-01-09T10:00:00") },
    ]);

    expect((await step(at("2030-01-09T09:59:00"))).messages).toBe(0);
    expect((await step(at("2030-01-09T10:00:00"))).messages).toBe(1);
    const [m] = await messagesTo(p.phone!);
    expect(m.payload).toMatchObject({
      purpose: "treatment_next_sitting",
      language: "en",
      params: ["Asha Rao", "Follow Dental", "Root canal (RCT) sitting", "between 10 and 14 January"],
    });
    expect(m.payload.buttonPayloads[0]).toBe(
      `book_step:${(await run((c) => patientPlans(c, p.id)))[0]!.steps[1]!.id}`,
    );
    // Running again at the same moment sends nothing more.
    expect((await step(at("2030-01-09T10:00:00"))).messages).toBe(0);

    expect((await runsFor(p.id))[0]).toMatchObject({ step: 1, next_at: at("2030-01-12T10:30:00") });
    await step(at("2030-01-12T10:30:00"));
    const last = await step(at("2030-01-16T10:00:00"));
    expect(last.tasks).toBe(1);
    expect((await runsFor(p.id))[0]).toMatchObject({ status: "exhausted" });
    const task = (await db.pool.query("select kind, title from tasks where patient_id = $1", [p.id])).rows;
    expect(task).toEqual([{ kind: "followup", title: "Treatment not continued: Asha Rao" }]);
  });

  it("booking the sitting stops the chase", async () => {
    const p = await patient();
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'rct'")).rows[0].id,
    );
    await run((c) =>
      createTreatmentPlan(c, {
        patientId: p.id,
        templateId: tpl,
        startDate: "2030-02-05",
        status: "accepted",
      }),
    );
    await plan(at("2030-02-04T09:00:00"));
    const first = (await run((c) => patientPlans(c, p.id)))[0]!.steps[0]!;
    await book(p.id, "2030-02-06T11:00:00", { step: first.id });
    await step(at("2030-02-04T10:00:00"));
    expect((await runsFor(p.id))[0]).toMatchObject({ status: "stopped_success" });
    expect(await messagesTo(p.phone!)).toEqual([]);
  });

  it("estimates: a follow-up two days after sending; accepting stops it", async () => {
    const p = await patient();
    const e = await run((c) =>
      createEstimate(c, { patientId: p.id, items: [{ label: "Crown", qty: 1, amountPaise: 1200000 }] }),
    );
    await run((c) =>
      sendEstimate(c, e.id, { storage: new FakeStorageProvider(), now: at("2030-03-01T12:00:00") }),
    );
    await plan(at("2030-03-01T12:05:00"));
    expect((await runsFor(p.id))[0]).toMatchObject({ kind: "estimate", next_at: at("2030-03-03T12:00:00") });
    await step(at("2030-03-03T12:00:00"));
    expect((await messagesTo(p.phone!)).map((m) => m.payload.params[2])).toEqual(["₹12,000"]);
    await run((c) => decideEstimate(c, e.id, "accepted"));
    await step(at("2030-03-09T11:00:00"));
    expect((await runsFor(p.id))[0]).toMatchObject({ status: "stopped_success" });
  });

  it("no-shows: a message two hours later, stopped once they book again", async () => {
    const p = await patient();
    const a = await book(p.id, "2030-04-02T11:00:00", { procedure: "filling" });
    await run((c) => setAppointmentStatus(c, a.id, "no_show"));
    await plan(at("2030-04-02T12:00:00"));
    await step(at("2030-04-02T13:30:00"));
    const [m] = await messagesTo(p.phone!);
    expect(m.payload).toMatchObject({
      purpose: "no_show",
      params: [expect.any(String), "Follow Dental", "Tuesday, 2 April"],
    });
    expect(m.payload.buttonPayloads[0]).toBe(`rebook:${a.id}`);
    await run(async (c) => {
      const b = await book(p.id, "2030-04-05T11:00:00");
      await c.query("update appointments set created_at = $2 where id = $1", [
        b.id,
        at("2030-04-03T09:00:00"),
      ]);
    });
    await step(at("2030-04-05T10:00:00"));
    expect((await runsFor(p.id))[0]).toMatchObject({ kind: "no_show", status: "stopped_success" });
  });

  it("unconfirmed: an AI call the evening before, a staff task if still unconfirmed, nothing once confirmed", async () => {
    await db.pool.query(
      "insert into clinic_channels (clinic_id, kind, external_id, display_phone) values ($1, 'voice', '+918047119999', '+918047119999') on conflict do nothing",
      [clinicId],
    );
    const p1 = await patient();
    await book(p1.id, "2030-05-08T11:00:00", { createdAt: "2030-05-01T10:00:00" });
    await plan(at("2030-05-07T12:00:00"));
    expect((await runsFor(p1.id))[0]).toMatchObject({
      kind: "unconfirmed",
      next_at: at("2030-05-07T19:00:00"),
    });
    const r = await step(at("2030-05-07T19:00:00"));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ purpose: "confirm_appointment" });
    const t = await step(at("2030-05-07T21:00:00"));
    expect(t.tasks).toBe(1);

    // A late-afternoon appointment: the 02:00 call waits for 09:00.
    const p2 = await patient();
    const a2 = await book(p2.id, "2030-05-08T18:00:00", { createdAt: "2030-05-01T10:00:00" });
    await plan(at("2030-05-07T12:00:00"));
    expect((await step(at("2030-05-08T02:00:00"))).calls).toHaveLength(0);
    expect((await runsFor(p2.id))[0]).toMatchObject({ next_at: at("2030-05-08T09:00:00") });
    await run((c) => setAppointmentStatus(c, a2.id, "confirmed"));
    await step(at("2030-05-08T09:00:00"));
    expect((await runsFor(p2.id))[0]).toMatchObject({ status: "stopped_success" });
  });

  it("recall: six months after a cleaning, unless they came back", async () => {
    const p = await patient();
    const a = await book(p.id, "2030-01-10T11:00:00", { procedure: "scaling" });
    await run((c) => setAppointmentStatus(c, a.id, "completed"));
    await plan(at("2030-01-10T12:00:00"));
    expect((await runsFor(p.id)).find((r) => r.kind === "recall")).toMatchObject({
      next_at: at("2030-07-10T10:00:00"),
    });
    await step(at("2030-07-10T10:00:00"));
    expect((await messagesTo(p.phone!)).map((m) => [m.payload.purpose, m.payload.params[2]])).toEqual([
      ["recall", "6"],
    ]);

    // A cleaning from years ago does not start a recall today (no blast on the first run).
    const old = await patient();
    const o = await book(old.id, "2030-01-12T11:00:00", { procedure: "scaling" });
    await run((c) => setAppointmentStatus(c, o.id, "completed"));
    await plan(at("2031-06-01T12:00:00"));
    expect((await runsFor(old.id)).filter((r) => r.kind === "recall")).toEqual([]);

    const q = await patient();
    const b = await book(q.id, "2030-01-11T11:00:00", { procedure: "scaling" });
    await run((c) => setAppointmentStatus(c, b.id, "completed"));
    await plan(at("2030-01-11T12:00:00"));
    await book(q.id, "2030-06-01T11:00:00");
    await step(at("2030-07-11T10:00:00"));
    expect((await runsFor(q.id)).find((r) => r.kind === "recall")).toMatchObject({
      status: "stopped_success",
    });
  });

  it("after-care only once a doctor approved the wording; next-day check-in with three answers", async () => {
    const p = await patient();
    const a = await book(p.id, "2030-08-05T11:00:00", { procedure: "extraction" });
    await run((c) => setAppointmentStatus(c, a.id, "completed"));
    await plan(at("2030-08-05T11:40:00"));
    await step(at("2030-08-05T12:30:00"));
    // Wording not approved yet: skipped, but the check-in still follows.
    expect(await messagesTo(p.phone!)).toEqual([]);
    await step(at("2030-08-06T10:00:00"));
    const [checkin] = await messagesTo(p.phone!);
    expect(checkin.payload.purpose).toBe("checkin");
    expect(checkin.payload.buttonPayloads).toEqual([
      `checkin:${a.id}:ok`,
      `checkin:${a.id}:pain`,
      `checkin:${a.id}:help`,
    ]);

    await run((c) =>
      c.query(
        "update procedure_types set aftercare = aftercare || '{\"approved\": true}' where code = 'extraction'",
      ),
    );
    const q = await patient();
    const b = await book(q.id, "2030-08-05T12:00:00", { procedure: "extraction" });
    await run((c) => setAppointmentStatus(c, b.id, "completed"));
    await plan(at("2030-08-05T12:40:00"));
    await step(at("2030-08-05T13:30:00"));
    const [care] = await messagesTo(q.phone!);
    expect(care.payload.params[3]).toMatch(/^Bite on the cotton/);
  });

  it("stops for opt-outs and on staff request; switched-off ladders start nothing", async () => {
    const p = await patient();
    const a = await book(p.id, "2030-09-02T11:00:00");
    await run((c) => setAppointmentStatus(c, a.id, "no_show"));
    await plan(at("2030-09-02T12:00:00"));
    await db.pool.query(
      "insert into opt_outs (clinic_id, phone, channel, category, source) values ($1, $2, 'all', 'all', 'test')",
      [clinicId, p.phone],
    );
    await step(at("2030-09-02T14:00:00"));
    expect((await runsFor(p.id))[0]).toMatchObject({ status: "stopped_optout" });
    expect(await messagesTo(p.phone!)).toEqual([]);

    const q = await patient();
    const b = await book(q.id, "2030-09-03T11:00:00");
    await run((c) => setAppointmentStatus(c, b.id, "no_show"));
    await plan(at("2030-09-03T12:00:00"));
    const [r] = await run((c) => listFollowups(c, { status: "active", kind: "no_show" }));
    expect(await run((c) => stopFollowup(c, r.id, "Patient called the desk"))).toBe(true);
    expect((await runsFor(q.id))[0]).toMatchObject({ status: "stopped_staff" });

    await run((c) => saveLadder(c, "no_show", [{ afterHours: 0, action: "staff_task" }], false));
    const s = await patient();
    const c2 = await book(s.id, "2030-09-04T11:00:00");
    await run((c) => setAppointmentStatus(c, c2.id, "no_show"));
    await plan(at("2030-09-04T12:00:00"));
    expect(await runsFor(s.id)).toEqual([]);
  });

  it("deposits: online bookings for procedures with an advance get a payment-link job", async () => {
    await run((c) =>
      c.query("update procedure_types set deposit_paise = 100000 where code = 'implant_surgery'"),
    );
    const p = await patient();
    const a = await book(p.id, "2030-10-10T11:00:00", { procedure: "implant_surgery" });
    await run((c) => c.query("update appointments set source = 'whatsapp' where id = $1", [a.id]));
    const jobs = new MemoryJobQueue();
    const r = await run((c) => planFollowups(c, at("2030-10-01T10:00:00"), { jobs }));
    expect(r.deposits).toBe(1);
    expect(jobs.jobs).toEqual([
      expect.objectContaining({ task: "request_deposit", payload: { appointmentId: a.id, clinicId } }),
    ]);
    expect(
      (await db.pool.query("select deposit_status, deposit_paise from appointments where id = $1", [a.id]))
        .rows[0],
    ).toEqual({
      deposit_status: "requested",
      deposit_paise: 100000,
    });
  });
});

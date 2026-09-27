import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import { bookDirect, setAppointmentStatus } from "../scheduling/service";
import {
  createTreatmentPlan,
  incompleteTreatments,
  nextSitting,
  patientPlans,
  setPlanStatus,
  updateStep,
} from "./treatments";

const at = (s: string) => new Date(`${s}+05:30`);
const NOW = at("2030-01-07T10:00:00");

describe.skipIf(!hasTestDatabase)("treatment plans", () => {
  let db: TestDatabase;
  let clinicId: string;
  let doctorId: string;
  let chairId: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);
  const template = (code: string) =>
    run(
      async (c) =>
        (await c.query("select id from treatment_templates where code = $1", [code])).rows[0].id as string,
    );
  let n = 0;
  const patient = () =>
    run((c) => createPatient(c, { name: `Plan Patient ${++n}`, phone: `+9190002${String(10000 + n)}` }));
  const book = (patientId: string, start: string, stepId: string) =>
    run(async (c) => {
      const { appointment } = await bookDirect(c, {
        patientId,
        doctorId,
        chairId,
        startsAt: at(start),
        endsAt: new Date(at(start).getTime() + 45 * 60_000),
        acknowledgeWarnings: true,
        treatmentStepId: stepId,
        now: NOW,
      });
      return appointment;
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Plan Dental",
        owner: { name: "Dr. P", phone: "9835000051" },
      }));
      doctorId = (
        await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. P') returning id", [
          clinicId,
        ])
      ).rows[0].id;
      chairId = (await client.query("select id from chairs where clinic_id = $1", [clinicId])).rows[0].id;
      await client.query(
        "update procedure_types set price_min_paise = 300000, price_max_paise = 500000 where clinic_id = $1 and code = 'rct_sitting'",
        [clinicId],
      );
      await client.query(
        "update procedure_types set price_min_paise = 800000, price_max_paise = 1200000 where clinic_id = $1 and code in ('crown_prep', 'crown_fitting')",
        [clinicId],
      );
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("new clinics get the standard templates", async () => {
    const codes = await run(async (c) =>
      (await c.query("select code from treatment_templates order by sort_order")).rows.map((r) => r.code),
    );
    expect(codes).toEqual(
      expect.arrayContaining(["rct_crown", "implant", "braces", "dentures", "extraction", "scaling"]),
    );
  });

  it("creates a plan from a template with windows and values from the price list", async () => {
    const p = await patient();
    const { id } = await run((c) =>
      createTreatmentPlan(c, {
        patientId: p.id,
        templateId: undefined as never,
        steps: undefined,
        title: "x",
        now: NOW,
      }).catch((e) => e),
    );
    expect(id).toBeUndefined();
    const plan = await run(async (c) =>
      createTreatmentPlan(c, {
        patientId: p.id,
        doctorId,
        templateId: await template("rct_crown"),
        teeth: ["36"],
        startDate: "2030-01-08",
        now: NOW,
      }),
    );
    const [view] = await run((c) => patientPlans(c, p.id));
    expect(view!.title).toBe("Root canal + crown");
    expect(
      view!.steps.map((s) => [s.procedure, s.expectedFrom, s.expectedTo, s.valuePaise, s.tooth]),
    ).toEqual([
      ["Root canal (RCT) sitting", "2030-01-08", "2030-01-15", 400000, "36"],
      ["Root canal (RCT) sitting", "2030-01-11", "2030-01-15", 400000, "36"],
      ["Root canal (RCT) sitting", "2030-01-14", "2030-01-18", 400000, "36"],
      ["Crown preparation and impression", "2030-01-21", "2030-01-28", 1000000, "36"],
      ["Crown / bridge fitting", "2030-01-28", "2030-01-31", 1000000, "36"],
    ]);
    expect(view!.totalPaise).toBe(3200000);
    expect(view!.status).toBe("proposed");
    expect((await run((c) => nextSitting(c, plan.id))).seq).toBe(1);
  });

  it("booking, completing and missing sittings keep the plan up to date", async () => {
    const p = await patient();
    const plan = await run(async (c) =>
      createTreatmentPlan(c, {
        patientId: p.id,
        doctorId,
        templateId: await template("rct_crown"),
        startDate: "2030-01-08",
        status: "accepted",
        now: NOW,
      }),
    );
    const steps = () => run((c) => patientPlans(c, p.id)).then((v) => v[0]!);
    const first = (await steps()).steps[0]!;
    const a1 = await book(p.id, "2030-01-08T10:00:00", first.id);
    expect((await steps()).steps[0]!.status).toBe("scheduled");
    expect((await steps()).status).toBe("in_progress");

    // Done a day late: the next sittings move with it.
    await run(async (c) => {
      await c.query("update appointments set starts_at = $2, ends_at = $3 where id = $1", [
        a1.id,
        at("2030-01-09T10:00:00"),
        at("2030-01-09T10:45:00"),
      ]);
      await setAppointmentStatus(c, a1.id, "completed");
    });
    let view = await steps();
    expect(view.steps.map((s) => [s.status, s.expectedFrom, s.expectedTo])).toEqual([
      ["done", "2030-01-08", "2030-01-15"],
      ["pending", "2030-01-12", "2030-01-16"],
      ["pending", "2030-01-15", "2030-01-19"],
      ["pending", "2030-01-22", "2030-01-29"],
      ["pending", "2030-01-29", "2030-02-01"],
    ]);
    expect(view.donePaise).toBe(400000);

    // A no-show puts the sitting back to pending.
    const a2 = await book(p.id, "2030-01-12T10:00:00", view.steps[1]!.id);
    expect((await steps()).steps[1]!.status).toBe("scheduled");
    await run((c) => setAppointmentStatus(c, a2.id, "no_show"));
    view = await steps();
    expect(view.steps[1]!.status).toBe("pending");
    expect(view.steps[1]!.appointmentId).toBeNull();

    // Skipping the rest completes the plan.
    for (const s of view.steps.slice(1)) await run((c) => updateStep(c, s.id, { skip: true }));
    expect((await steps()).status).toBe("completed");
    expect(await run((c) => nextSitting(c, plan.id))).toBeNull();
  });

  it("lists incomplete treatments with remaining value, overdue first", async () => {
    const before = await run((c) => incompleteTreatments(c, NOW));
    const p1 = await patient();
    const p2 = await patient();
    await run(async (c) =>
      createTreatmentPlan(c, {
        patientId: p1.id,
        templateId: await template("rct_crown"),
        startDate: "2029-12-01",
        status: "accepted",
        now: NOW,
      }),
    );
    const plan2 = await run(async (c) =>
      createTreatmentPlan(c, {
        patientId: p2.id,
        templateId: await template("rct"),
        startDate: "2030-01-20",
        status: "accepted",
        now: NOW,
      }),
    );
    // Proposed plans are not counted until the patient accepts.
    const p3 = await patient();
    await run(async (c) =>
      createTreatmentPlan(c, { patientId: p3.id, templateId: await template("rct"), now: NOW }),
    );

    const after = await run((c) => incompleteTreatments(c, NOW));
    expect(after.totals.plans - before.totals.plans).toBe(2);
    expect(after.totals.remainingPaise - before.totals.remainingPaise).toBe(3200000 + 1200000);
    const first = after.rows.find((r) => r.patientId === p1.id)!;
    expect(first).toMatchObject({
      sittingsLeft: 5,
      remainingPaise: 3200000,
      nextExpectedTo: "2029-12-08",
      overdueDays: 30,
    });
    expect(after.rows.find((r) => r.patientId === p2.id)!.overdueDays).toBe(0);
    expect(after.rows.indexOf(first)).toBeLessThan(after.rows.findIndex((r) => r.patientId === p2.id));

    await run((c) => setPlanStatus(c, plan2.id, "abandon", "Moved city"));
    const final = await run((c) => incompleteTreatments(c, NOW));
    expect(final.rows.some((r) => r.patientId === p2.id)).toBe(false);
  });
});

import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordPayment, reverseEntry } from "../billing/ledger";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import { ownerReport, periodRange, queueNightlyReport, recoveredPayments } from "./owner";

const DAY = "2030-03-12"; // a Tuesday
const at = (iso: string) => new Date(`${iso}+05:30`);

describe("report periods", () => {
  it("day, week from Monday, month", () => {
    expect(periodRange("day", DAY, "Asia/Kolkata")).toMatchObject({ start: "2030-03-12", end: "2030-03-13" });
    expect(periodRange("week", DAY, "Asia/Kolkata")).toMatchObject({
      start: "2030-03-11",
      end: "2030-03-18",
    });
    expect(periodRange("month", "2030-12-31", "Asia/Kolkata")).toMatchObject({
      start: "2030-12-01",
      end: "2031-01-01",
    });
    expect(periodRange("day", DAY, "Asia/Kolkata").from).toEqual(at("2030-03-12T00:00:00"));
  });
});

describe.skipIf(!hasTestDatabase)("owner report", () => {
  let db: TestDatabase;
  let clinicId: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "system" }, fn);

  /** A follow-up (e.g. an estimate reminder) that reached this patient at `when`. */
  const touched = (patientId: string, kind: string, when: Date) =>
    run(async (c) => {
      const r = await c.query(
        `insert into followup_runs (clinic_id, kind, subject_type, subject_id, patient_id, next_at, status)
         values (app.current_clinic_id(), $1, 'appointment', gen_random_uuid(), $2, $3, 'exhausted') returning id`,
        [kind, patientId, when],
      );
      await c.query(
        "insert into followup_actions (clinic_id, run_id, step, action, result, at) values (app.current_clinic_id(), $1, 0, 'whatsapp', 'queued', $2)",
        [r.rows[0].id, when],
      );
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Report Dental",
        owner: { name: "Dr. R", phone: "9835000151" },
      }));
      await client.query(
        "update clinic_memberships set invited_phone = '+919835000151' where clinic_id = $1",
        [clinicId],
      );
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("recovered: paid within 30 days after a follow-up; each payment once, to the latest follow-up; corrections excluded", async () => {
    const [a, b, c, d] = await run(async (cl) =>
      Promise.all(
        ["A", "B", "C", "D"].map((n, i) =>
          createPatient(cl, { name: `Patient ${n}`, phone: `+91900990000${i}` }),
        ),
      ),
    );
    await touched(a!.id, "estimate", at("2030-02-20T10:00:00"));
    await touched(a!.id, "treatment_continuity", at("2030-03-05T10:00:00"));
    await run((cl) =>
      recordPayment(cl, {
        patientId: a!.id,
        amountPaise: 600000,
        method: "upi",
        now: at("2030-03-12T12:00:00"),
      }),
    );
    // Paid 31 days after the only follow-up: not counted.
    await touched(b!.id, "recall", at("2030-02-09T10:00:00"));
    await run((cl) =>
      recordPayment(cl, {
        patientId: b!.id,
        amountPaise: 50000,
        method: "cash",
        now: at("2030-03-12T12:00:00"),
      }),
    );
    // No follow-up at all: not counted.
    await run((cl) =>
      recordPayment(cl, {
        patientId: c!.id,
        amountPaise: 70000,
        method: "cash",
        now: at("2030-03-12T13:00:00"),
      }),
    );
    // Counted, then found to be a mistake and reversed: not counted.
    await touched(d!.id, "no_show", at("2030-03-10T10:00:00"));
    const wrong = await run((cl) =>
      recordPayment(cl, {
        patientId: d!.id,
        amountPaise: 99900,
        method: "upi",
        now: at("2030-03-12T14:00:00"),
      }),
    );
    await run((cl) => reverseEntry(cl, { entryId: wrong.id, reason: "Entered twice" }));

    const rec = await run((cl) => recoveredPayments(cl, periodRange("day", DAY, "Asia/Kolkata")));
    expect(rec.map((r) => [r.patient, r.amountPaise, r.kind])).toEqual([
      ["Patient A", 600000, "treatment_continuity"],
    ]);

    const day = await run((cl) => ownerReport(cl, { period: "day", date: DAY }));
    expect(day.collectedPaise).toBe(600000 + 50000 + 70000);
    expect(day.recovered).toMatchObject({ totalPaise: 600000, byKind: { treatment_continuity: 600000 } });
    const month = await run((cl) => ownerReport(cl, { period: "month", date: DAY }));
    expect(month.recovered.totalPaise).toBe(600000);
  });

  it("the 9 pm WhatsApp goes once a day, only at 9 pm, and not when the owner switched it off", async () => {
    expect(await run((c) => queueNightlyReport(c, { now: at("2030-03-12T20:30:00") }))).toBeNull();
    const id = await run((c) =>
      queueNightlyReport(c, { now: at("2030-03-12T21:05:00"), dashboardUrl: "https://app.sentio.care" }),
    );
    expect(id).toBeTruthy();
    expect(await run((c) => queueNightlyReport(c, { now: at("2030-03-12T21:40:00") }))).toBeNull();
    const msg = (await db.pool.query("select to_phone, payload from outbox where id = $1", [id])).rows[0];
    expect(msg.to_phone).toBe("+919835000151");
    expect(msg.payload.params[2]).toContain("₹7,200 collected");
    expect(msg.payload.params[2]).toContain("Recovered after follow-ups this month: ₹6,000");
    expect(msg.payload.params[3]).toBe("https://app.sentio.care/reports?date=2030-03-12");
    await db.pool.query(
      `update clinics set settings = settings || '{"reports": {"nightly": false}}' where id = $1`,
      [clinicId],
    );
    expect(await run((c) => queueNightlyReport(c, { now: at("2030-03-13T21:00:00") }))).toBeNull();
  });
});

import { withClinic, type ClinicContext } from "@dentalos/db";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { localMinutesOf } from "../time.js";
import {
  bookDirect,
  bookFromHold,
  cancelAppointment,
  findSlots,
  materializeEmergencyReserves,
  moveAppointment,
  offerSlots,
  setAppointmentStatus,
} from "./service.js";

const IST = "Asia/Kolkata";
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const hhmm = (d: Date) => {
  const m = localMinutesOf(d, IST);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
// All dates are far in the future so "now" never interferes; 2030-01-07 is a Monday.
const MON = "2030-01-07";
const NOW = at("2030-01-01", "09:00");

describe.skipIf(!hasTestDatabase)("scheduling service", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  let ctx: ClinicContext;
  const run = <T>(fn: (client: PoolClient) => Promise<T>, extra: Partial<ClinicContext> = {}) =>
    withClinic(db.pool, { ...ctx, ...extra }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
    ctx = { clinicId: c.clinicId, actor: "user:test", role: "receptionist" };
    for (const weekday of [1, 2, 3, 4, 5, 6]) {
      await db.pool.query(
        "insert into working_hours (clinic_id, branch_id, weekday, start_time, end_time) values ($1,$2,$3,'10:00','13:00'),($1,$2,$3,'17:00','20:00')",
        [c.clinicId, c.branchId, weekday],
      );
    }
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("finds slots from the database configuration", async () => {
    const slots = await run((cl) =>
      findSlots(cl, { procedureId: c.procedureId, fromDate: MON, toDate: MON, now: NOW }),
    );
    expect(hhmm(slots[0]!.start)).toBe("10:00");
    expect(slots.every((s) => s.date === MON)).toBe(true);
  });

  it("offers 3 spread-out held options, which then disappear from other callers' searches", async () => {
    const holds = await run((cl) =>
      offerSlots(cl, {
        procedureId: c.procedureId,
        fromDate: MON,
        toDate: MON,
        now: NOW,
        count: 3,
        holder: "call:A",
      }),
    );
    expect(holds).toHaveLength(3);
    expect(holds.map((h) => hhmm(h.start))).toEqual(["10:00", "11:30", "17:00"]);
    const others = await run((cl) =>
      findSlots(cl, { procedureId: c.procedureId, fromDate: MON, toDate: MON, now: NOW }),
    );
    // Two doctors and two chairs: 10:00 still has one pair free, but the held pair is excluded.
    const at1000 = others.filter((s) => hhmm(s.start) === "10:00");
    expect(at1000.every((s) => s.doctorId !== holds[0]!.doctorId && s.chairId !== holds[0]!.chairId)).toBe(
      true,
    );
  });

  it("books from a hold, releases the caller's other holds, and is idempotent on retry", async () => {
    const holds = await run((cl) =>
      offerSlots(cl, {
        procedureId: c.procedureId,
        fromDate: "2030-01-08",
        toDate: "2030-01-08",
        now: NOW,
        count: 2,
        holder: "call:B",
      }),
    );
    const book = () =>
      run((cl) =>
        bookFromHold(cl, {
          holdId: holds[1]!.holdId,
          patientId: c.patientIds[0]!,
          source: "voice",
          idempotencyKey: "call:B:book",
        }),
      );
    const appt = await book();
    expect(appt.startsAt.getTime()).toBe(holds[1]!.start.getTime());
    expect(appt.bufferMin).toBe(5);
    const remaining = await db.pool.query(
      "select count(*)::int as n from slot_holds where holder = 'call:B'",
    );
    expect(remaining.rows[0].n).toBe(0);
    const again = await book();
    expect(again.id).toBe(appt.id);
  });

  it("an unknown or already used hold is refused clearly (never a silent success)", async () => {
    await expect(
      run((cl) =>
        bookFromHold(cl, {
          holdId: "00000000-0000-4000-8000-000000000000",
          patientId: c.patientIds[0]!,
          source: "voice",
        }),
      ),
    ).rejects.toMatchObject({ code: "hold_not_found" });
  });

  it("20 callers racing for slots never get the same doctor or chair at the same time", async () => {
    const day = "2030-01-09";
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        run(async (cl) => {
          const [hold] = await offerSlots(cl, {
            procedureId: c.procedureId,
            fromDate: day,
            toDate: day,
            partsOfDay: ["morning"],
            now: NOW,
            count: 1,
            holder: `race:${i}`,
          });
          if (!hold) return null;
          return bookFromHold(cl, {
            holdId: hold.holdId,
            patientId: c.patientIds[i % 2]!,
            source: "whatsapp",
          });
        }),
      ),
    );
    const booked = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    // Morning 10:00–13:00, 30 min + 5 min buffer, 2 doctors × 2 chairs → capacity is limited; all distinct.
    expect(booked.length).toBeGreaterThan(0);
    for (let i = 0; i < booked.length; i++) {
      for (let j = i + 1; j < booked.length; j++) {
        const a = booked[i]!;
        const b = booked[j]!;
        const overlap =
          a.startsAt.getTime() < b.endsAt.getTime() + b.bufferMin * 60_000 &&
          b.startsAt.getTime() < a.endsAt.getTime() + a.bufferMin * 60_000;
        if (overlap) {
          expect(a.doctorId).not.toBe(b.doctorId);
          expect(a.chairId).not.toBe(b.chairId);
        }
      }
    }
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failures) expect(f.reason).toBeInstanceOf(DomainError);
  });

  describe("staff bookings", () => {
    it("books with the procedure's duration and buffer", async () => {
      const { appointment, warnings } = await run((cl) =>
        bookDirect(cl, {
          patientId: c.patientIds[0]!,
          doctorId: c.doctorIds[0]!,
          chairId: c.chairIds[0]!,
          procedureTypeId: c.procedureId,
          startsAt: at("2030-01-10", "10:00"),
          now: NOW,
        }),
      );
      expect(warnings).toEqual([]);
      expect(hhmm(appointment.endsAt)).toBe("10:30");
    });

    it("asks for confirmation outside hours, then books when acknowledged", async () => {
      const input = {
        patientId: c.patientIds[0]!,
        doctorId: c.doctorIds[0]!,
        chairId: c.chairIds[0]!,
        procedureTypeId: c.procedureId,
        startsAt: at("2030-01-10", "15:00"),
        now: NOW,
      };
      await expect(run((cl) => bookDirect(cl, input))).rejects.toMatchObject({
        code: "needs_confirmation",
        details: { warnings: ["outside_working_hours"] },
      });
      const { warnings } = await run((cl) => bookDirect(cl, { ...input, acknowledgeWarnings: true }));
      expect(warnings).toEqual(["outside_working_hours"]);
    });

    it("never double-books, even when staff acknowledge warnings", async () => {
      await expect(
        run((cl) =>
          bookDirect(cl, {
            patientId: c.patientIds[1]!,
            doctorId: c.doctorIds[0]!,
            chairId: c.chairIds[1]!,
            startsAt: at("2030-01-10", "10:15"),
            endsAt: at("2030-01-10", "10:45"),
            acknowledgeWarnings: true,
            now: NOW,
          }),
        ),
      ).rejects.toMatchObject({ code: "slot_taken" });
    });

    it("moves and resizes, keeping duration by default, and refuses occupied targets", async () => {
      const { appointment } = await run((cl) =>
        bookDirect(cl, {
          patientId: c.patientIds[1]!,
          doctorId: c.doctorIds[1]!,
          chairId: c.chairIds[1]!,
          startsAt: at("2030-01-10", "11:00"),
          endsAt: at("2030-01-10", "11:45"),
          now: NOW,
        }),
      );
      const moved = await run((cl) =>
        moveAppointment(cl, appointment.id, { startsAt: at("2030-01-10", "12:00"), now: NOW }),
      );
      expect(hhmm(moved.appointment.endsAt)).toBe("12:45");
      const resized = await run((cl) =>
        moveAppointment(cl, appointment.id, { endsAt: at("2030-01-10", "12:30"), now: NOW }),
      );
      expect(hhmm(resized.appointment.endsAt)).toBe("12:30");
      await expect(
        run((cl) =>
          moveAppointment(cl, appointment.id, {
            startsAt: at("2030-01-10", "10:00"),
            doctorId: c.doctorIds[0]!,
            now: NOW,
          }),
        ),
      ).rejects.toMatchObject({ code: "slot_taken" });
    });

    it("cancel frees the slot; completing updates the patient's last visit", async () => {
      const { appointment } = await run((cl) =>
        bookDirect(cl, {
          patientId: c.patientIds[1]!,
          doctorId: c.doctorIds[0]!,
          chairId: c.chairIds[0]!,
          startsAt: at("2030-01-11", "10:00"),
          endsAt: at("2030-01-11", "10:30"),
          now: NOW,
        }),
      );
      await run((cl) => cancelAppointment(cl, appointment.id, "patient called"));
      const { appointment: replacement } = await run((cl) =>
        bookDirect(cl, {
          patientId: c.patientIds[0]!,
          doctorId: c.doctorIds[0]!,
          chairId: c.chairIds[0]!,
          startsAt: at("2030-01-11", "10:00"),
          endsAt: at("2030-01-11", "10:30"),
          now: NOW,
        }),
      );
      await expect(run((cl) => setAppointmentStatus(cl, appointment.id, "booked"))).rejects.toMatchObject({
        code: "slot_taken",
      });
      await run((cl) => setAppointmentStatus(cl, replacement.id, "completed"));
      const { rows } = await db.pool.query("select last_visit_at from patients where id = $1", [
        c.patientIds[0],
      ]);
      expect(rows[0].last_visit_at.getTime()).toBe(at("2030-01-11", "10:00").getTime());
      await expect(run((cl) => setAppointmentStatus(cl, replacement.id, "cancelled"))).rejects.toMatchObject({
        code: "invalid",
      });
    });
  });

  describe("emergency reserves", () => {
    it("are materialised idempotently, hidden from normal search, and fillable by staff", async () => {
      // Wednesday 2030-01-16, 19:00–19:30 on chair 1.
      await db.pool.query(
        "insert into emergency_slots (clinic_id, branch_id, chair_id, weekday, start_time, duration_min) values ($1,$2,$3,3,'19:00',30)",
        [c.clinicId, c.branchId, c.chairIds[0]],
      );
      const client = await db.pool.connect();
      try {
        const first = await materializeEmergencyReserves(client, 14, at("2030-01-10", "09:00"));
        const second = await materializeEmergencyReserves(client, 14, at("2030-01-10", "09:00"));
        expect(first).toBe(2); // Jan 16 and Jan 23 are within 14 days of Jan 10
        expect(second).toBe(0);
      } finally {
        client.release();
      }
      const slots = await run((cl) =>
        findSlots(cl, {
          procedureId: c.procedureId,
          fromDate: "2030-01-16",
          toDate: "2030-01-16",
          now: NOW,
          partsOfDay: ["evening"],
        }),
      );
      expect(slots.filter((s) => hhmm(s.start) === "19:00").every((s) => s.chairId !== c.chairIds[0])).toBe(
        true,
      );

      const placement = {
        patientId: c.patientIds[0]!,
        doctorId: c.doctorIds[0]!,
        chairId: c.chairIds[0]!,
        startsAt: at("2030-01-16", "19:00"),
        endsAt: at("2030-01-16", "19:30"),
        now: NOW,
      };
      await expect(run((cl) => bookDirect(cl, placement))).rejects.toMatchObject({ code: "slot_taken" });
      const { appointment } = await run((cl) => bookDirect(cl, { ...placement, useEmergencyReserve: true }));
      expect(appointment.chairId).toBe(c.chairIds[0]);
    });
  });
});

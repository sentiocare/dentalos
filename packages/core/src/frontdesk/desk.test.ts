import { withClinic } from "@dentalos/db";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCharge, recordPayment } from "../billing/ledger";
import { bookDirect, setAppointmentStatus } from "../scheduling/service";
import { localDateOf } from "../time";
import { addWalkIn, deskCounts, leaveQueue, listQueue, sendIn, visitBilling, visitCheckout } from "./desk";

const minute = 60_000;

describe.skipIf(!hasTestDatabase)("front desk: queue, walk-ins, checkout", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  let patient3: string;
  let patient4: string;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "system", role: "receptionist" }, fn);
  // Real time: tokens are numbered by the clinic's date at the moment of arrival.
  const now = () => new Date(Math.floor(Date.now() / minute) * minute);
  const today = () => localDateOf(new Date(), "Asia/Kolkata");
  const book = (patientId: string, doctor: number, chair: number, startsAt: Date, minutes = 30) =>
    run((cl) =>
      bookDirect(cl, {
        patientId,
        doctorId: c.doctorIds[doctor]!,
        chairId: c.chairIds[chair]!,
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * minute),
        acknowledgeWarnings: true,
        now: new Date(startsAt.getTime() - 60 * minute),
      }),
    ).then((r) => r.appointment);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
    const add = async (name: string, phone: string) =>
      (
        await db.pool.query(
          "insert into patients (clinic_id, name, phone) values ($1, $2, $3) returning id",
          [c.clinicId, name, phone],
        )
      ).rows[0].id as string;
    patient3 = await add("Walk In One", "+919811155501");
    patient4 = await add("Walk In Two", "+919811155502");
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("booked patients get a token on arrival; walk-ins get the next one; the queue follows the appointment", async () => {
    const booked = await book(c.patientIds[0]!, 0, 0, new Date(now().getTime() + 120 * minute));
    await run((cl) => setAppointmentStatus(cl, booked.id, "checked_in"));
    const walk = await run((cl) => addWalkIn(cl, { patientId: patient3, note: "Tooth pain since morning" }));
    expect(walk.token).toBe(2);
    await expect(run((cl) => addWalkIn(cl, { patientId: patient3 }))).rejects.toThrow(/token 2/);

    let queue = await run((cl) => listQueue(cl, today()));
    expect(queue.map((q) => [q.token, q.status, q.walkIn])).toEqual([
      [1, "waiting", false],
      [2, "waiting", true],
    ]);
    expect(queue[1]!.note).toBe("Tooth pain since morning");

    await run((cl) => setAppointmentStatus(cl, booked.id, "in_chair"));
    await run((cl) => setAppointmentStatus(cl, booked.id, "completed"));
    queue = await run((cl) => listQueue(cl, today()));
    expect(queue[0]).toMatchObject({ token: 1, status: "done" });
    expect(queue[0]!.calledAt).not.toBeNull();
  });

  it("a walk-in goes in only into the time free before the doctor's next booked patient", async () => {
    // Dr. Verma has a booked patient in 20 minutes; the walk-in's scaling (30 min + 5 buffer) is cut short.
    await book(c.patientIds[1]!, 1, 1, new Date(now().getTime() + 20 * minute));
    const walk = await run((cl) =>
      addWalkIn(cl, { patientId: patient4, doctorId: c.doctorIds[1], procedureTypeId: c.procedureId }),
    );
    const { appointmentId } = await run((cl) => sendIn(cl, walk.id, { chairId: c.chairIds[0] }));
    const a = (
      await db.pool.query("select starts_at, ends_at, status, source from appointments where id = $1", [
        appointmentId,
      ])
    ).rows[0];
    expect(a.status).toBe("in_chair");
    expect(a.source).toBe("walk_in");
    expect((a.ends_at.getTime() - a.starts_at.getTime()) / minute).toBeLessThanOrEqual(15);
    const entry = (await run((cl) => listQueue(cl, today()))).find((q) => q.id === walk.id)!;
    expect(entry).toMatchObject({ status: "with_doctor", walkIn: true, appointmentId });

    // Dr. Verma is now with that walk-in: the next walk-in can't be sent to Dr. Verma.
    await db.pool.query("update queue_entries set status = 'left' where patient_id = $1", [patient3]);
    const next = await run((cl) => addWalkIn(cl, { patientId: patient3 }));
    await expect(
      run((cl) => sendIn(cl, next.id, { doctorId: c.doctorIds[1], chairId: c.chairIds[1] })),
    ).rejects.toThrow(/doctor is busy/);
    await expect(run((cl) => sendIn(cl, next.id, { chairId: c.chairIds[1] }))).rejects.toThrow(
      /doctor and the chair/,
    );
    // The doctor finishes early: the visit ends now, so the next walk-in can go straight in.
    await run((cl) => setAppointmentStatus(cl, appointmentId, "completed"));
    const ended = (await db.pool.query("select ends_at from appointments where id = $1", [appointmentId]))
      .rows[0];
    expect(ended.ends_at.getTime()).toBeLessThanOrEqual(Date.now() + minute);
    await run((cl) => leaveQueue(cl, next.id));
    expect((await run((cl) => listQueue(cl, today()))).find((q) => q.id === next.id)!.status).toBe("left");
    await expect(run((cl) => leaveQueue(cl, next.id))).rejects.toThrow(/waiting walk-in/);
  });

  it("checkout suggests the treatment's price and shows what this visit has been billed and paid", async () => {
    await db.pool.query(
      "update procedure_types set price_min_paise = 80000, price_max_paise = 80000 where id = $1",
      [c.procedureId],
    );
    const a = await book(c.patientIds[1]!, 0, 1, new Date(now().getTime() + 300 * minute));
    await db.pool.query("update appointments set procedure_type_id = $2 where id = $1", [
      a.id,
      c.procedureId,
    ]);
    let checkout = await run((cl) => visitCheckout(cl, a.id));
    expect(checkout.suggested).toEqual([
      expect.objectContaining({ description: "Scaling", amountPaise: 80000, priceRange: null }),
    ]);
    expect(checkout.chargedPaise).toBe(0);

    await run((cl) =>
      addCharge(cl, {
        patientId: c.patientIds[1]!,
        amountPaise: 80000,
        description: "Scaling",
        appointmentId: a.id,
      }),
    );
    await run((cl) =>
      recordPayment(cl, {
        patientId: c.patientIds[1]!,
        amountPaise: 50000,
        method: "upi",
        appointmentId: a.id,
      }),
    );
    checkout = await run((cl) => visitCheckout(cl, a.id));
    expect(checkout).toMatchObject({
      chargedPaise: 80000,
      paidPaise: 50000,
      balancePaise: 30000,
      suggested: [],
    });
    expect(checkout.entries.find((e) => e.kind === "payment")!.receiptId).toBeTruthy();
    expect(await run((cl) => visitBilling(cl, [a.id]))).toEqual({
      [a.id]: { chargedPaise: 80000, paidPaise: 50000 },
    });

    await db.pool.query(
      "insert into tasks (clinic_id, kind, priority, title, created_by) values ($1, 'callback', 'critical', 'Call back', 'test')",
      [c.clinicId],
    );
    expect(await run(deskCounts)).toMatchObject({ tasks: 1, critical: 1, leads: 0 });
  });
});

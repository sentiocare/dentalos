import { bookDirect, createPatient, registerStandardTemplates } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PatientSimulator } from "./testing/harness";
import { CallerSimulator, setupVoiceClinic } from "./testing/voice-harness";
import { checkConfirmationCall } from "./voice/outbound";

// Tuesday 8 January 2030, 11:00 IST.
const NOW = new Date("2030-01-08T11:00:00+05:30");
const text = (m: { kind: string } & Record<string, unknown>) => String(m.text ?? m.body ?? "");

/**
 * Phase 5 acceptance, the degradation part (PLAN §5.6): with the usage wallet paused, AI answering stops,
 * but emergencies always reach people, on the phone and on WhatsApp.
 */
describe.skipIf(!hasTestDatabase)("usage wallet: what pauses and what never does", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  let n = 0;
  const run = <T>(fn: (c: import("pg").PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, fn);
  const setBalance = async (paise: number) => {
    const cur = Number(
      (await db.pool.query("select balance_paise from wallets where clinic_id = $1", [clinic.clinicId]))
        .rows[0].balance_paise,
    );
    if (cur !== paise)
      await db.pool.query(
        "insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'adjustment', $2)",
        [clinic.clinicId, paise - cur],
      );
    await db.pool.query("update wallets set enforced = true where clinic_id = $1", [clinic.clinicId]);
  };
  const patient = () =>
    new PatientSimulator(db.pool, clinic, `+9190070${String(10000 + ++n)}`, new Date(NOW));

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupVoiceClinic(db.pool);
    await run((c) =>
      c.query('update clinics set settings = settings || \'{"voice": {"outboundFlowId": "123456"}}\''),
    );
    await run(async (c) => {
      await registerStandardTemplates(c);
      await c.query("update message_templates set meta_status = 'approved'");
    });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("paid up: the assistant answers calls; suspended or in grace: the clinic's own phone rings", async () => {
    await setBalance(200000);
    const ok = new CallerSimulator(db.pool, "+919007000001", NOW);
    await ok.dial();
    expect(ok.call.route).toBe("assistant");
    for (const balance of [-100, -500000]) {
      await setBalance(balance);
      const caller = new CallerSimulator(db.pool, "+919007000002", NOW);
      expect(await caller.dial()).toEqual([]);
      expect(caller.call.route).toBe("forwarded_wallet");
    }
  });

  it("suspended: an emergency on WhatsApp still gets the safety script and alerts the doctor", async () => {
    await setBalance(-500000);
    const p = patient();
    const reply = await p.say("bahut khoon aa raha hai daant nikalne ke baad, ruk nahi raha");
    expect(reply.map(text).join(" ")).toMatch(/doctor|डॉक्टर|112/i);
    const alert = (
      await db.pool.query(
        "select status, category from outbox where purpose = 'staff_emergency_alert' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(alert).toEqual({ status: "sent", category: "critical" });
    const task = (
      await db.pool.query(
        "select priority from tasks where kind = 'emergency' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(task.priority).toBe("critical");
  });

  it("suspended: chat works by rules only (no model, nothing metered); paid up: model usage is metered", async () => {
    await setBalance(-500000);
    const p = patient();
    await p.say("Namaste");
    await p.tap("agree", "Agree");
    await p.say("mujhe apne daant ke baare mein kuch poochna tha, woh jo pichhli baar hua tha");
    expect(p.llm.extractRequests).toHaveLength(0);

    await setBalance(200000);
    const q = patient();
    await q.say("Namaste");
    await q.tap("agree", "Agree");
    await q.say("mujhe apne daant ke baare mein kuch poochna tha, woh jo pichhli baar hua tha");
    expect(q.llm.extractRequests.length).toBeGreaterThan(0);
    const metered = await run(
      async (c) =>
        (
          await c.query(
            "select count(*)::int as n from usage_ledger where kind like 'llm_%' and ref_type = 'message'",
          )
        ).rows[0].n,
    );
    expect(metered).toBeGreaterThan(0);
  });

  it("confirmation calls are not placed while the wallet is not paid up", async () => {
    await setBalance(200000);
    const appt = await run(async (c) => {
      const pt = await createPatient(c, { name: "Call Check", phone: "+919007000099" });
      const doctor = (await c.query("select id from doctors limit 1")).rows[0].id;
      const chair = (await c.query("select id from chairs limit 1")).rows[0].id;
      return (
        await bookDirect(c, {
          patientId: pt.id,
          doctorId: doctor,
          chairId: chair,
          startsAt: new Date("2030-01-09T11:00:00+05:30"),
          endsAt: new Date("2030-01-09T11:30:00+05:30"),
          acknowledgeWarnings: true,
        })
      ).appointment;
    });
    const evening = new Date("2030-01-08T19:00:00+05:30");
    expect((await checkConfirmationCall(db.pool, clinic.clinicId, appt.id, evening)).ok).toBe(true);
    await setBalance(-100);
    expect(await checkConfirmationCall(db.pool, clinic.clinicId, appt.id, evening)).toEqual({
      ok: false,
      reason: "wallet_paused",
    });
  });
});

import { advanceFollowups, createLead, leadDetail } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallerSimulator, setupVoiceClinic } from "../testing/voice-harness";
import { checkLeadCall } from "./outbound";

// Monday 7 January 2030, 11:00 IST.
const NOW = new Date("2030-01-07T11:00:00+05:30");

/**
 * The assistant phones new leads from ads: within minutes of the lead arriving, it introduces the clinic,
 * finds out what they need and books a consultation on the call. Busy → a person calls back; not interested
 * → the lead is closed. Leads already chatting on WhatsApp aren't called.
 */
describe.skipIf(!hasTestDatabase)("AI calls to new leads", () => {
  let db: TestDatabase;
  let clinicId: string;
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "system" }, fn);
  const phone = () => `+9190097${String(10000 + ++n)}`;
  const lead = (p: string, extra: { name?: string; need?: "implant" | "braces" | null } = {}) =>
    run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: `lg-call-${n}`,
        phone: p,
        name: extra.name ?? "Rakesh Kumar",
        need: extra.need ?? null,
        campaign: "Implants Jan",
        now: NOW,
      }),
    );

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

  it("the follow-up asks for an AI call 3 minutes after the first WhatsApp, and every rule is checked again", async () => {
    const p = phone();
    const { id } = await lead(p);
    await run((c) => advanceFollowups(c, NOW));
    const stepped = await run((c) => advanceFollowups(c, new Date(NOW.getTime() + 3 * 60_000)));
    expect(stepped.calls).toEqual([expect.objectContaining({ purpose: "lead_call", leadId: id })]);

    expect(await checkLeadCall(db.pool, clinicId, id, NOW)).toMatchObject({
      ok: true,
      phone: p,
      flowId: "123456",
    });
    expect(await checkLeadCall(db.pool, clinicId, id, new Date("2030-01-07T20:30:00+05:30"))).toEqual({
      ok: false,
      reason: "outside_hours",
    });
    await db.pool.query(
      `update clinics set settings = jsonb_set(settings, '{voice,leadCalls}', 'false') where id = $1`,
      [clinicId],
    );
    expect(await checkLeadCall(db.pool, clinicId, id, NOW)).toEqual({ ok: false, reason: "calls_off" });
    await db.pool.query(`update clinics set settings = settings #- '{voice,leadCalls}' where id = $1`, [
      clinicId,
    ]);
    // Replied on WhatsApp meanwhile: they're talking to the assistant already.
    await db.pool.query("update leads set first_reply_at = $2 where id = $1", [id, NOW]);
    expect(await checkLeadCall(db.pool, clinicId, id, NOW)).toEqual({ ok: false, reason: "chatting" });
  });

  it("a lead arriving at night is called when calling hours open, not skipped", async () => {
    const p = phone();
    const night = new Date("2030-01-07T22:30:00+05:30");
    const { id } = await run((c) =>
      createLead(c, { source: "meta_form", externalId: "lg-night", phone: p, name: "Night Owl", now: night }),
    );
    await run((c) => advanceFollowups(c, night));
    const late = await run((c) => advanceFollowups(c, new Date(night.getTime() + 5 * 60_000)));
    expect(late.calls).toEqual([]);
    const morning = await run((c) => advanceFollowups(c, new Date("2030-01-08T09:00:00+05:30")));
    expect(morning.calls).toEqual([expect.objectContaining({ purpose: "lead_call", leadId: id })]);
  });

  it("the lead picks up: says what they need and books a consultation, with the name from the form", async () => {
    const p = phone();
    const { id } = await lead(p, { name: "anjali mishra" });
    const call = new CallerSimulator(db.pool, p, NOW);
    const hello = (await call.answerLeadCall(id, clinicId)).join(" ");
    expect(hello).toMatch(/डिजिटल असिस्टेंट/);
    expect(hello).toMatch(/दाँतों के इलाज के बारे में पूछा था/);
    expect((await call.say("haan boliye", "hi-IN")).join(" ")).toMatch(/किस चीज़ में मदद/);
    expect((await call.say("mujhe implant karwana hai", "hi-IN")).join(" ")).toMatch(/परामर्श बुक कर दूँ/);
    const offered = (await call.say("haan kar do", "hi-IN")).join(" ");
    expect(offered).not.toMatch(/नाम/);
    // Pick the first time offered, then confirm.
    await call.say("pehla", "hi-IN");
    await call.say("haan", "hi-IN");
    expect((await call.record()).outcome).toBe("booked");
    const d = await run((c) => leadDetail(c, id));
    expect(d.lead).toMatchObject({ stage: "booked", need: "implant" });
    const patient = (await db.pool.query("select name from patients where phone = $1", [p])).rows[0];
    expect(patient.name).toBe("Anjali Mishra");
    expect(d.activities.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["called", "qualified", "booked"]),
    );
  });

  it("busy: a person is asked to call back; not interested: the lead is closed", async () => {
    const busy = phone();
    const a = await lead(busy, { need: "braces" });
    const c1 = new CallerSimulator(db.pool, busy, NOW);
    expect((await c1.answerLeadCall(a.id, clinicId)).join(" ")).toMatch(/ब्रेसेस के बारे में/);
    expect((await c1.say("abhi busy hoon baad mein karna", "hi-IN")).join(" ")).toMatch(/बाद में फ़ोन करेगा/);
    expect(c1.last!.end).toEqual({ kind: "hangup" });
    const tasks = (
      await db.pool.query("select title, due_at from tasks where lead_id = $1 and status = 'open'", [a.id])
    ).rows;
    expect(tasks).toEqual([
      { title: "Call back (as agreed): Rakesh Kumar", due_at: new Date(NOW.getTime() + 2 * 3600_000) },
    ]);

    const no = phone();
    const b = await lead(no, { need: "implant" });
    const c2 = new CallerSimulator(db.pool, no, NOW);
    await c2.answerLeadCall(b.id, clinicId);
    await c2.say("haan", "hi-IN");
    expect((await c2.say("nahi mujhe nahi chahiye", "hi-IN")).join(" ")).toMatch(/समय देने के लिए धन्यवाद/);
    expect((await run((c) => leadDetail(c, b.id))).lead).toMatchObject({ stage: "lost" });
  });

  it("a price question on the call is answered from the clinic's list, then the call goes on", async () => {
    const p = phone();
    const { id } = await lead(p, { need: "implant" });
    const call = new CallerSimulator(db.pool, p, NOW);
    await call.answerLeadCall(id, clinicId);
    await call.say("yes", "en-IN");
    const answer = (await call.say("how much does a consultation cost", "en-IN")).join(" ");
    expect(answer).toMatch(/consultation/i);
    expect(call.last!.end).toBeUndefined();
  });
});

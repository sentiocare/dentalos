import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastButtons, PatientSimulator, setupWhatsAppClinic } from "../testing/harness";

// Monday 7 January 2030, 09:00 IST. "kal" = Tuesday 8th.
const MONDAY = new Date("2030-01-07T09:00:00+05:30");
const text = (m: { kind: string } & Record<string, unknown>) => String(m.text ?? m.body ?? "");

describe.skipIf(!hasTestDatabase)("WhatsApp assistant (Phase 2 acceptance)", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  let n = 0;
  const patient = () =>
    new PatientSimulator(db.pool, clinic, `+9190000${String(10000 + ++n)}`, new Date(MONDAY));
  const inClinic = <T>(fn: (c: import("pg").PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, fn);

  /** Gets a new patient past the consent notice. */
  async function agreed(p: PatientSimulator, first = "Namaste") {
    const sent = await p.say(first);
    expect(text(sent[0]!)).toContain("Sentio Care");
    expect(lastButtons(sent)[0]?.id).toBe("agree");
    return p.tap("agree", "Agree");
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupWhatsAppClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("shows the consent notice first and records consent when the patient agrees", async () => {
    const p = patient();
    const welcome = await agreed(p);
    expect(text(welcome[0]!)).toContain("digital assistant");
    const { rows } = await db.pool.query(
      "select granted, notice_version, captured_via from consents where phone = $1",
      [p.phone],
    );
    expect(rows).toEqual([{ granted: true, notice_version: "wa-v1", captured_via: "whatsapp_agree_button" }]);
  });

  it("books a new patient end to end: name, reason, three held times, read-back, explicit yes, booked", async () => {
    const p = patient();
    await p.say("kal shaam appointment chahiye");
    const afterAgree = await p.tap("agree", "Agree");
    expect(text(afterAgree.at(-1)!)).toMatch(/poora naam/);
    const askReason = await p.say("Ramesh Kumar");
    expect(text(askReason.at(-1)!)).toMatch(/Kis kaam/);
    const offered = await p.say("safai karwani hai");
    const slots = lastButtons(offered);
    expect(slots).toHaveLength(3);
    expect(text(offered.at(-1)!)).toMatch(/Mangalvaar, 8 January, shaam/);
    const confirm = await p.tap(slots[0]!.id, slots[0]!.title);
    expect(text(confirm.at(-1)!)).toMatch(
      /Ramesh Kumar[\s\S]*Mangalvaar, 8 January, shaam 5 baje[\s\S]*Dr\. /,
    );
    // Nothing is booked before the explicit yes.
    expect(
      (await db.pool.query("select count(*)::int as n from appointments where source = 'whatsapp'")).rows[0]
        .n,
    ).toBe(0);
    const done = await p.say("haan");
    expect(text(done.at(-1)!)).toMatch(
      /^Ho gaya! Ramesh Kumar ka appointment Mangalvaar, 8 January, shaam 5 baje/,
    );
    const { rows } = await db.pool.query(
      "select a.status, a.source, p.name, p.phone, pt.code from appointments a join patients p on p.id = a.patient_id join procedure_types pt on pt.id = a.procedure_type_id where p.phone = $1",
      [p.phone],
    );
    expect(rows).toEqual([
      { status: "booked", source: "whatsapp", name: "Ramesh Kumar", phone: p.phone, code: "scaling" },
    ]);
    expect((await db.pool.query("select count(*)::int as n from slot_holds")).rows[0].n).toBe(0);
  });

  it("an unclear reason books a consultation, not a treatment", async () => {
    const p = patient();
    await agreed(p);
    await p.say("appointment");
    await p.say("Sunita Devi");
    const offered = await p.say("pata nahi, kuch problem hai");
    expect(text(offered.at(-1)!)).toMatch(/Consultation ke liye/);
  });

  it("confirms, reschedules and cancels an existing appointment over WhatsApp", async () => {
    const p = patient();
    await agreed(p);
    await p.say("appointment book karna hai");
    await p.say("Mahesh Prasad");
    const offered = await p.say("checkup");
    await p.tap(lastButtons(offered)[0]!.id);
    await p.say("haan");
    const appt = (
      await db.pool.query(
        "select a.id, a.starts_at from appointments a join patients p on p.id = a.patient_id where p.phone = $1",
        [p.phone],
      )
    ).rows[0];

    // Confirm from the reminder's button.
    const confirmed = await p.tap(`confirm:${appt.id}`, "Confirm");
    expect(text(confirmed.at(-1)!)).toMatch(/pakka ho gaya/);
    expect(
      (await db.pool.query("select status from appointments where id = $1", [appt.id])).rows[0].status,
    ).toBe("confirmed");

    // Reschedule.
    const options = await p.say("time change karna hai");
    const choices = lastButtons(options);
    expect(choices.length).toBeGreaterThan(0);
    const pick = choices.at(-1)!;
    await p.tap(pick.id, pick.title);
    const moved = await p.tap("yes_book");
    expect(text(moved.at(-1)!)).toMatch(/^Ho gaya! Mahesh Prasad ka appointment ab/);
    const after = (await db.pool.query("select starts_at, status from appointments where id = $1", [appt.id]))
      .rows[0];
    expect(after.starts_at.getTime()).not.toBe(appt.starts_at.getTime());

    // Cancel.
    const ask = await p.say("appointment cancel karna hai");
    expect(lastButtons(ask).map((b) => b.id)).toEqual(["cancel_yes", "keep"]);
    const cancelled = await p.tap("cancel_yes");
    expect(text(cancelled.at(-1)!)).toMatch(/cancel kar diya gaya/);
    expect(
      (await db.pool.query("select status from appointments where id = $1", [appt.id])).rows[0].status,
    ).toBe("cancelled");
  });

  it("never confirms a booking that the database did not save", async () => {
    const p = patient();
    await agreed(p);
    await p.say("kal subah appointment");
    await p.say("Kiran Oraon");
    const offered = await p.say("checkup");
    const slot = lastButtons(offered)[0]!;
    await p.tap(slot.id);
    // Meanwhile the hold expires and the front desk books that exact time for someone else.
    const hold = (await db.pool.query("select * from slot_holds where id = $1", [slot.id.slice(5)])).rows[0];
    await db.pool.query("delete from slot_holds where holder = $1", [hold.holder]);
    await inClinic(async (c) => {
      const other = (
        await c.query(
          "insert into patients (clinic_id, name) values (app.current_clinic_id(), 'Walk In') returning id",
        )
      ).rows[0].id;
      await c.query(
        "insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at) values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6)",
        [hold.branch_id, other, hold.doctor_id, hold.chair_id, hold.starts_at, hold.ends_at],
      );
    });
    const reply = await p.say("haan");
    expect(reply.map(text).join("\n")).not.toMatch(/Ho gaya/);
    expect(text(reply[0]!)).toMatch(/kisi aur ne le liya/);
    expect(
      (
        await db.pool.query(
          "select count(*)::int as n from appointments a join patients p on p.id = a.patient_id where p.phone = $1",
          [p.phone],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("staff takeover silences the assistant until released", async () => {
    const p = patient();
    await agreed(p);
    await db.pool.query("update conversations set mode = 'human' where phone = $1", [p.phone]);
    expect(await p.say("RCT kitna ka hai?")).toEqual([]);
    const stored = await db.pool.query("select body from messages where body = 'RCT kitna ka hai?'");
    expect(stored.rowCount).toBe(1);
    await db.pool.query("update conversations set mode = 'bot' where phone = $1", [p.phone]);
    expect(text((await p.say("RCT kitna ka hai?"))[0]!)).toMatch(/₹3,500 se ₹7,000/);
  });

  it("STOP opts out of every business-initiated message, START opts back in", async () => {
    const p = patient();
    await agreed(p);
    expect(text((await p.say("STOP"))[0]!)).toMatch(/START/);
    const { rows } = await db.pool.query(
      "select channel, category from opt_outs where phone = $1 and revoked_at is null",
      [p.phone],
    );
    expect(rows).toEqual([{ channel: "whatsapp", category: "all" }]);
    const policy = await db.pool.query("select count(*)::int as n from opt_outs where phone = $1", [p.phone]);
    expect(policy.rows[0].n).toBe(1);
    await p.say("START");
    expect(
      (
        await db.pool.query(
          "select count(*)::int as n from opt_outs where phone = $1 and revoked_at is null",
          [p.phone],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("a duplicated webhook is answered once", async () => {
    const p = patient();
    await agreed(p);
    const event = {
      type: "inbound_message" as const,
      eventId: "msg:dup-1",
      providerMessageId: "wamid.dup-1",
      from: p.phone,
      channelId: "109876543210",
      at: p.now,
      content: { kind: "text" as const, text: "clinic kahan hai" },
    };
    const first = await p.deliver([event, event]);
    const again = await p.deliver([event]);
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);
  });

  it("emergencies: fixed script, 112 advice for breathing trouble, critical task and doctor alert — even before consent", async () => {
    const p = patient();
    const reply = await p.say("mere gaal mein sujan hai aur saans lene mein dikkat ho rahi hai");
    expect(text(reply[0]!)).toMatch(/112/);
    const task = (
      await db.pool.query(
        "select kind, priority from tasks where kind = 'emergency' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(task).toEqual({ kind: "emergency", priority: "critical" });
    const alert = (
      await db.pool.query(
        "select to_phone, category, purpose from outbox where purpose = 'staff_emergency_alert' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(alert).toEqual({
      to_phone: "+919835000001",
      category: "critical",
      purpose: "staff_emergency_alert",
    });
    expect(reply.map(text).join(" ")).not.toMatch(/book/i);
  });

  it("answers timings, address, prices from the approved list only, doctors, and 'are you a robot?' honestly", async () => {
    const p = patient();
    await agreed(p);
    expect(text((await p.say("Sunday ko khula hai kya?"))[0]!)).toMatch(
      /Monday–Saturday: 10:00–14:00, 17:00–21:00\nSunday: Band/,
    );
    expect(text((await p.say("clinic kahan hai"))[0]!)).toContain("https://maps.google.com/?q=Lalpur");
    expect(text((await p.say("RCT kitna ka hai?"))[0]!)).toMatch(/usually ₹3,500 se ₹7,000 ke beech/);
    // Implant price not approved for patients: no number, offer a consultation.
    const implant = await p.say("implant kitne ka hai");
    expect(text(implant[0]!)).toMatch(/consultation mein exact estimate/);
    expect(text(implant[0]!)).not.toMatch(/₹/);
    expect(text((await p.say("kya aap robot ho?"))[0]!)).toMatch(/digital assistant hoon, koi insaan nahi/);
  });

  it("replies in the patient's language", async () => {
    const hi = patient();
    const notice = await hi.say("नमस्ते");
    expect(text(notice[0]!)).toMatch(/आप .* की डिजिटल असिस्टेंट/);
    const en = patient();
    await en.say("Hello");
    const welcome = await en.tap("agree");
    expect(text(welcome[0]!)).toMatch(/^Namaste! I'm the digital assistant/);
  });

  it("voice notes are transcribed and answered", async () => {
    const p = patient();
    await agreed(p);
    p.voice.transcriptFor = () => ({ text: "clinic ka address kya hai", language: "hi-IN" });
    const reply = await p.voiceNote();
    expect(text(reply[0]!)).toContain("Lalpur");
    expect(
      (await db.pool.query("select body from messages where kind = 'audio' order by created_at desc limit 1"))
        .rows[0].body,
    ).toBe("clinic ka address kya hai");
  });

  it("asks a person to call back when asked, and logs a task", async () => {
    const p = patient();
    await agreed(p);
    expect(text((await p.say("mujhe kisi se baat karni hai"))[0]!)).toMatch(/clinic team/);
    const task = (
      await db.pool.query(
        "select kind, priority from tasks where kind = 'callback' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(task).toEqual({ kind: "callback", priority: "high" });
  });
});

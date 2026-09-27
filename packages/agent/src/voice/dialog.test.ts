import { createPatient, localMinutesOf } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkOutput } from "../safety/output-filter";
import { CallerSimulator, CLINIC_PHONE, setupVoiceClinic } from "../testing/voice-harness";

// Monday 7 January 2030, 09:00 IST. "kal" = Tuesday 8th.
const MONDAY = new Date("2030-01-07T09:00:00+05:30");
const IST = "Asia/Kolkata";

describe.skipIf(!hasTestDatabase)("phone assistant (Phase 3 acceptance)", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string };
  let n = 0;
  const newPhone = () => `+9191000${String(10000 + ++n)}`;
  const caller = (phone: string | null = newPhone()) => new CallerSimulator(db.pool, phone, new Date(MONDAY));
  const inClinic = <T>(fn: (c: import("pg").PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, fn);
  const knownPatient = async (name: string) => {
    const phone = newPhone();
    const p = await inClinic((c) => createPatient(c, { name, phone, source: "staff" }));
    return { phone, id: p.id };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupVoiceClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("greets with the recording notice, then a known caller books in Hindi (Devanagari transcript)", async () => {
    const { phone, id } = await knownPatient("Sunita Devi");
    const call = caller(phone);
    const hello = await call.dial();
    expect(hello[0]).toMatch(/रिकॉर्ड/);
    expect(call.last!.say[0]!.interruptible).toBe(false);

    expect((await call.say("मुझे कल शाम को चेकअप के लिए आना है", "hi-IN")).join(" ")).toContain(
      "Sunita Devi",
    );
    const offer = (await call.say("हाँ जी", "hi-IN")).join(" ");
    expect(offer).toMatch(/कल शाम .* या कल शाम/);
    expect(call.last!.expect).toBe("choice");
    const readback = (await call.say("पहला वाला", "hi-IN")).join(" ");
    expect(readback).toMatch(/Sunita Devi, कल शाम .* बुक कर दूँ/);
    const done = (await call.say("हाँ", "hi-IN")).join(" ");
    expect(done).toMatch(/बुक हो गया/);
    expect(done).toMatch(/WhatsApp/);
    expect(call.last!.planMessages).toBe(true);

    const record = await call.record();
    expect(record.outcome).toBe("booked");
    expect(record.appointment_id).toBeTruthy();
    const appt = (
      await db.pool.query("select patient_id, source, starts_at from appointments where id = $1", [
        record.appointment_id,
      ])
    ).rows[0];
    expect(appt).toMatchObject({ patient_id: id, source: "voice" });
    expect(localMinutesOf(appt.starts_at, IST)).toBeGreaterThanOrEqual(16 * 60);
    expect(record.summary).toMatch(/^Booked Sunita Devi for tomorrow at/);

    expect((await call.say("नहीं, बस धन्यवाद", "hi-IN")).join(" ")).toMatch(/धन्यवाद/);
    expect(call.last!.end).toEqual({ kind: "hangup" });
    const consent = (
      await db.pool.query("select purpose, notice_version from consents where phone = $1", [phone])
    ).rows;
    expect(consent).toEqual([{ purpose: "call_recording", notice_version: "voice-v1" }]);
  });

  it("a new caller books in English at the time they asked for", async () => {
    const call = caller();
    await call.dial();
    const q = (await call.say("Hi, I'd like to book a cleaning tomorrow at 5 pm please", "en-IN")).join(" ");
    expect(q).toMatch(/name/i);
    expect(call.last!.expect).toBe("name");
    const offer = (await call.say("My name is Priya Singh", "en-IN")).join(" ");
    // 5 PM itself was taken by an earlier call in this file, so the nearest time comes first.
    expect(offer).toMatch(/Scaling and polishing, I have tomorrow at 5(:\d\d)? PM/);
    const readback = (await call.say("the first one", "en-IN")).join(" ");
    expect(readback).toMatch(/Priya Singh, tomorrow at 5(:\d\d)? PM, with Dr\. Sharma\. Shall I book it\?/);
    await call.say("yes", "en-IN");
    const record = await call.record();
    expect(record.outcome).toBe("booked");
    const patient = (
      await db.pool.query(
        "select name, phone, source from patients where id = (select patient_id from appointments where id = $1)",
        [record.appointment_id],
      )
    ).rows[0];
    expect(patient).toEqual({ name: "Priya Singh", phone: call.phone, source: "voice" });
  });

  it("offers another time when the caller does not like the options", async () => {
    const call = caller();
    await call.dial();
    await call.say("appointment chahiye kal subah checkup ke liye", "hi-IN");
    await call.say("Rahul Kumar", "hi-IN");
    const first = call.heard.at(-1)!;
    const again = (await call.say("nahi, parson shaam ko", "hi-IN")).join(" ");
    expect(again).not.toBe(first);
    expect(again).toMatch(/बुधवार|परसों|Wednesday/);
    await call.say("doosra", "hi-IN");
    expect(call.last!.expect).toBe("yes_no");
  });

  it("emergency: fixed script with 112 advice, doctor first in the transfer, alerts and a critical task", async () => {
    const call = caller();
    await call.dial();
    const said = (await call.say("मेरे गाल में सूजन है और साँस लेने में दिक्कत हो रही है", "hi-IN")).join(
      " ",
    );
    expect(said).toMatch(/112/);
    expect(call.last!.say.every((u) => !u.interruptible)).toBe(true);
    expect(call.last!.end).toEqual({ kind: "transfer", to: "emergency" });
    const record = await call.record();
    expect(record.outcome).toBe("emergency");
    expect(record.transfer_kind).toBe("emergency");
    expect(record.transfer_numbers).toEqual(["+919835000001", CLINIC_PHONE]);
    const task = (
      await db.pool.query("select kind, priority, call_id from tasks where call_id = $1", [record.id])
    ).rows;
    expect(task).toEqual([{ kind: "emergency", priority: "critical", call_id: record.id }]);
    const alert = (
      await db.pool.query("select to_phone, category from outbox where dedupe_key like $1", [
        `call-emergency:${record.id}:%`,
      ])
    ).rows;
    expect(alert).toEqual([{ to_phone: "+919835000001", category: "critical" }]);
  });

  it("emergency in the middle of a booking still wins", async () => {
    const call = caller();
    await call.dial();
    await call.say("book an appointment for tomorrow", "en-IN");
    await call.say("my face is swollen and I can't swallow", "en-IN");
    expect(call.last!.end).toEqual({ kind: "transfer", to: "emergency" });
  });

  it("asking for a person transfers to the clinic phone", async () => {
    const call = caller();
    await call.dial();
    const said = (await call.say("kisi insaan se baat karni hai", "hi-IN")).join(" ");
    expect(said).toMatch(/स्टाफ़ से जोड़/);
    expect(call.last!.end).toEqual({ kind: "transfer", to: "staff" });
    expect((await call.record()).transfer_numbers).toEqual([CLINIC_PHONE]);
  });

  it("never gives medical advice; offers a consultation instead", async () => {
    const call = caller();
    await call.dial();
    const said = (await call.say("dard ke liye kaunsi dawai lu", "hi-IN")).join(" ");
    expect(said).toMatch(/सलाह नहीं दे सकती/);
    expect(said).not.toMatch(/paracetamol|ibuprofen|टैबलेट|गोली ले/i);
    const next = (await call.say("haan", "hi-IN")).join(" ");
    expect(next).toMatch(/नाम|name/);
  });

  it("prices only from the clinic's approved list", async () => {
    const call = caller();
    await call.dial();
    expect((await call.say("RCT kitne ka hota hai", "hi-IN")).join(" ")).toMatch(/3500 से 7000 रुपये/);
    await call.say("nahi", "hi-IN");
    await call.say("implant kitne ka hai", "hi-IN");
    const said = call.heard.at(-1)!;
    expect(said).toMatch(/consultation/);
    expect(said).not.toMatch(/\d{3,}/);
  });

  it("timings, address and the honest robot answer", async () => {
    const call = caller();
    await call.dial();
    expect((await call.say("clinic kab khulta hai", "hi-IN")).join(" ")).toMatch(/खुला रहता है/);
    await call.say("haan", "hi-IN");
    expect((await call.say("address kya hai", "hi-IN")).join(" ")).toContain("Lalpur");
    await call.say("haan", "hi-IN");
    expect((await call.say("kya aap robot ho", "hi-IN")).join(" ")).toMatch(/कोई इंसान नहीं/);
  });

  it("silence: asks once, then ends the call politely", async () => {
    const call = caller();
    await call.dial();
    expect((await call.silence()).join(" ")).toMatch(/लाइन पर/);
    await call.silence();
    expect(call.last!.end).toEqual({ kind: "hangup" });
    expect((await call.record()).outcome).toBe("no_input");
  });

  it("repeated mishearing: offers staff, then hands over", async () => {
    const call = caller();
    await call.dial();
    await call.mumble();
    const offer = (await call.mumble()).join(" ");
    expect(offer).toMatch(/स्टाफ़ से जोड़ दूँ/);
    await call.say("haan ji", "hi-IN");
    expect(call.last!.end).toEqual({ kind: "transfer", to: "staff" });
  });

  it("keypad: 0 always reaches staff", async () => {
    const call = caller();
    await call.dial();
    await call.press("0");
    expect(call.last!.end).toEqual({ kind: "transfer", to: "staff" });
  });

  it("cancels the caller's own appointment after a clear yes", async () => {
    const { phone } = await knownPatient("Ajay Verma");
    const book = caller(phone);
    await book.dial();
    await book.say("kal checkup ke liye appointment chahiye", "hi-IN");
    await book.say("haan", "hi-IN");
    await book.say("pehla", "hi-IN");
    await book.say("haan", "hi-IN");
    const apptId = (await book.record()).appointment_id;
    await book.hangUp();

    const call = caller(phone);
    await call.dial();
    expect((await call.say("mera appointment cancel karna hai", "hi-IN")).join(" ")).toMatch(
      /Ajay Verma .* cancel कर दूँ/,
    );
    await call.say("haan", "hi-IN");
    expect(
      (await db.pool.query("select status from appointments where id = $1", [apptId])).rows[0].status,
    ).toBe("cancelled");
    expect((await call.record()).outcome).toBe("cancelled");
  });

  it("moves the caller's appointment to a new time", async () => {
    const { phone } = await knownPatient("Meena Kumari");
    const book = caller(phone);
    await book.dial();
    await book.say("kal checkup ke liye appointment chahiye", "hi-IN");
    await book.say("haan", "hi-IN");
    await book.say("pehla", "hi-IN");
    await book.say("haan", "hi-IN");
    const apptId = (await book.record()).appointment_id;
    await book.hangUp();

    const call = caller(phone);
    await call.dial();
    expect((await call.say("appointment ka time badalna hai", "hi-IN")).join(" ")).toMatch(/कौन-सा दिन/);
    await call.say("parson subah 11 baje", "hi-IN");
    await call.say("pehla", "hi-IN");
    const done = (await call.say("haan", "hi-IN")).join(" ");
    expect(done).toMatch(/अब .* का है/);
    const moved = (await db.pool.query("select starts_at from appointments where id = $1", [apptId])).rows[0]
      .starts_at;
    expect(moved.toISOString().slice(0, 10)).toBe("2030-01-09");
  });

  it("only acts on appointments of the calling number", async () => {
    const call = caller();
    await call.dial();
    expect((await call.say("cancel my appointment", "en-IN")).join(" ")).toMatch(
      /couldn't find an upcoming appointment/,
    );
  });

  it("switches to English on request", async () => {
    const call = caller();
    await call.dial();
    const said = (await call.say("can we talk in English please", "en-IN")).join(" ");
    expect(said).toMatch(/continue in English/);
    expect(said).toMatch(/How can I help/);
  });

  it("forwards to the clinic when the voice service is unhealthy or switched off", async () => {
    const call = caller();
    expect(await call.dial({ voiceHealthy: false })).toEqual([]);
    expect(call.call.route).toBe("forwarded_unhealthy");
    await inClinic((c) =>
      c.query('update clinics set settings = settings || \'{"voice": {"enabled": false}}\' where id = $1', [
        clinic.clinicId,
      ]),
    );
    const off = caller();
    await off.dial();
    expect(off.call.route).toBe("forwarded_disabled");
    await inClinic((c) =>
      c.query("update clinics set settings = settings - 'voice' where id = $1", [clinic.clinicId]),
    );
  });

  it("'after hours' mode forwards during working hours and answers after them", async () => {
    await inClinic((c) =>
      c.query(
        'update clinics set settings = settings || \'{"voice": {"answerMode": "after_hours"}}\' where id = $1',
        [clinic.clinicId],
      ),
    );
    const day = new CallerSimulator(db.pool, newPhone(), new Date("2030-01-07T11:00:00+05:30"));
    await day.dial();
    expect(day.call.route).toBe("forwarded_hours");
    const night = new CallerSimulator(db.pool, newPhone(), new Date("2030-01-07T23:00:00+05:30"));
    await night.dial();
    expect(night.call.route).toBe("assistant");
    await inClinic((c) =>
      c.query("update clinics set settings = settings - 'voice' where id = $1", [clinic.clinicId]),
    );
  });

  it("nothing the assistant said in these calls trips the safety filter", async () => {
    const { rows } = await db.pool.query("select text from call_turns where speaker = 'assistant'");
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) expect(checkOutput(r.text).ok, r.text).toBe(true);
  });
});

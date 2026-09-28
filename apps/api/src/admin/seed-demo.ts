/* eslint-disable no-console -- command-line tool output */
/**
 * Creates "Sharma Dental Clinic (Demo)" for sales demos and end-to-end tests: Hindi names, fictional Indian
 * numbers (+91 90000 xxxxx), visiting consultants, family links, past visits and this week's schedule.
 *
 *   DATABASE_URL=... pnpm --filter @dentalos/api seed:demo            # create if missing
 *   DATABASE_URL=... pnpm --filter @dentalos/api seed:demo -- --reset # delete the demo clinic and recreate
 *   ... seed:demo -- --reset --at=12:10                               # today as it looks at 12:10
 *   ... seed:demo -- --owner-email=you@gmail.com --reception-email=desk@gmail.com  # real inboxes, for a live demo
 */
import {
  addCharge,
  addDays,
  createLead,
  createTreatmentPlan,
  recordCallOutcome,
  meter,
  recordPayment,
  estimateFromPlan,
  bookDirect,
  createClinic,
  createPatient,
  linkFamily,
  addWalkIn,
  localDateOf,
  recordTooth,
  saveNote,
  saveRxTemplate,
  writePrescription,
  type RxItem,
  type ToothCondition,
  localMinutesOf,
  setAppointmentStatus,
  weekdayOf,
  zonedInstant,
} from "@dentalos/core";
import { createPool, withClinic, type Pool, type PoolClient } from "@dentalos/db";

export const DEMO_NAME = "Sharma Dental Clinic (Demo)";
export const DEMO_OWNER_PHONE = "+919000000001";
export const DEMO_RECEPTION_PHONE = "+919000000002";
/** Sign-in emails. Local development accepts any code; a live demo needs real inboxes (see the options above). */
export const DEMO_OWNER_EMAIL = "owner@demo.sentio";
export const DEMO_RECEPTION_EMAIL = "reception@demo.sentio";
const TZ = "Asia/Kolkata";

/** Small deterministic PRNG so every demo looks the same. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const FIRST_F = [
  "Sunita",
  "Anita",
  "Kavita",
  "Pooja",
  "Neha",
  "Priyanka",
  "Rekha",
  "Savitri",
  "Geeta",
  "Meena",
  "Asha",
  "Ritu",
  "Kiran",
  "Shalini",
  "Sarita",
  "Nisha",
  "Anjali",
  "Kumari",
  "Pinki",
  "Radha",
];
const FIRST_M = [
  "Ramesh",
  "Suresh",
  "Mahendra",
  "Rajesh",
  "Amit",
  "Vikas",
  "Sanjay",
  "Manoj",
  "Ravi",
  "Deepak",
  "Anil",
  "Ajay",
  "Sunil",
  "Pankaj",
  "Rohit",
  "Arjun",
  "Bablu",
  "Shankar",
  "Dinesh",
  "Mukesh",
];
const LAST = [
  "Kumar",
  "Singh",
  "Sharma",
  "Prasad",
  "Mahto",
  "Oraon",
  "Munda",
  "Gupta",
  "Sahu",
  "Verma",
  "Yadav",
  "Mishra",
  "Tirkey",
  "Pandey",
  "Choudhary",
  "Ekka",
];
const AREAS = [
  "Lalpur",
  "Harmu",
  "Doranda",
  "Kanke",
  "Bariatu",
  "Morabadi",
  "Hinoo",
  "Ratu Road",
  "Kokar",
  "Namkum",
];
const SOURCES = ["walk_in", "referral", "google", "instagram", "practo", "justdial"];

const PRICES: Record<string, [number, number]> = {
  consultation: [300, 500],
  xray_iopa: [150, 300],
  scaling: [800, 1500],
  filling: [800, 2000],
  rct_sitting: [3500, 7000],
  extraction: [500, 1500],
  surgical_extraction: [3000, 6000],
  crown_prep: [3500, 12000],
  implant_surgery: [25000, 45000],
  ortho_consultation: [500, 800],
  ortho_adjustment: [800, 1500],
  denture_impression: [8000, 25000],
  whitening: [5000, 10000],
};

async function reset(pool: Pool) {
  const { rows } = await pool.query("select id from clinics where name = $1", [DEMO_NAME]);
  if (!rows.length) return;
  // Money ledgers are append-only; the demo is the one place they are wiped, with their guards paused
  // inside this transaction (needs the table owner, as the admin commands run).
  const guarded: [string, string][] = [
    ["patient_ledger", "patient_ledger_append_only"],
    ["usage_ledger", "usage_ledger_append_only"],
    ["wallet_credits", "wallet_credits_append_only"],
    ["consents", "consents_append_only"],
    ["prescriptions", "prescriptions_not_deleted"],
  ];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [table, trigger] of guarded)
      await client.query(`alter table ${table} disable trigger ${trigger}`);
    for (const { id } of rows) {
      // Order matters: appointments reference patients, doctors and chairs without cascading.
      await client.query("delete from slot_holds where clinic_id = $1", [id]);
      await client.query("delete from receipts where clinic_id = $1", [id]);
      await client.query("delete from invoice_charges where clinic_id = $1", [id]);
      await client.query("delete from patient_ledger where clinic_id = $1", [id]);
      await client.query("delete from invoices where clinic_id = $1", [id]);
      await client.query("delete from payment_links where clinic_id = $1", [id]);
      await client.query("delete from queue_entries where clinic_id = $1", [id]);
      await client.query("delete from prescriptions where clinic_id = $1", [id]);
      await client.query("delete from clinical_notes where clinic_id = $1", [id]);
      await client.query("delete from tooth_findings where clinic_id = $1", [id]);
      await client.query("delete from appointments where clinic_id = $1", [id]);
      // Treatment data references patients and procedure types without cascading.
      await client.query("delete from estimates where clinic_id = $1", [id]);
      await client.query("delete from treatment_steps where clinic_id = $1", [id]);
      await client.query("delete from treatment_plans where clinic_id = $1", [id]);
      await client.query("delete from clinics where id = $1", [id]);
    }
    await client.query("delete from resource_occupancy where clinic_id = any($1)", [rows.map((r) => r.id)]);
    for (const [table, trigger] of guarded)
      await client.query(`alter table ${table} enable trigger ${trigger}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function seedDemo(
  pool: Pool,
  now = new Date(),
  emails = { owner: DEMO_OWNER_EMAIL, reception: DEMO_RECEPTION_EMAIL },
): Promise<string> {
  const existing = await pool.query("select id from clinics where name = $1", [DEMO_NAME]);
  if (existing.rows[0]) return existing.rows[0].id;

  const client = await pool.connect();
  let clinicId: string;
  let branchId: string;
  try {
    await client.query("begin");
    ({ clinicId, branchId } = await createClinic(client, {
      name: DEMO_NAME,
      city: "Ranchi",
      phone: "+916512345678",
      owner: { name: "Dr. Rakesh Sharma", phone: DEMO_OWNER_PHONE, email: emails.owner },
    }));
    await client.query(
      "update clinics set address = 'Shop 12, Main Road, Lalpur', state = 'Jharkhand', pincode = '834001', maps_url = 'https://maps.google.com/?q=Lalpur+Ranchi' where id = $1",
      [clinicId],
    );
    await client.query(
      "insert into clinic_memberships (clinic_id, invited_phone, invited_email, display_name, role) values ($1, $2, $3, 'Priya (Reception)', 'receptionist')",
      [clinicId, DEMO_RECEPTION_PHONE, emails.reception],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  const ctx = { clinicId, actor: "system" as const, role: "owner" as const };
  const ids = await withClinic(pool, ctx, async (c) => {
    const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].id as string;
    const sharma = await one(
      "insert into doctors (clinic_id, name, speciality, kind, phone, emergency_order, color) values ($1, 'Dr. Rakesh Sharma', 'Dental surgeon', 'permanent', '+919000000001', 1, '#0f766e') returning id",
      [clinicId],
    );
    const verma = await one(
      "insert into doctors (clinic_id, name, speciality, kind, phone, emergency_order, color) values ($1, 'Dr. Neha Verma', 'Dental surgeon', 'permanent', '+919000000003', 2, '#7c3aed') returning id",
      [clinicId],
    );
    const mehta = await one(
      "insert into doctors (clinic_id, name, speciality, kind, phone, color) values ($1, 'Dr. Amit Mehta', 'Orthodontist', 'visiting', '+919000000004', '#c2410c') returning id",
      [clinicId],
    );
    const prasad = await one(
      "insert into doctors (clinic_id, name, speciality, kind, phone) values ($1, 'Dr. Sunil Prasad', 'Endodontist', 'on_call', '+919000000005') returning id",
      [clinicId],
    );
    const singh = await one(
      "insert into doctors (clinic_id, name, speciality, kind, phone) values ($1, 'Dr. Kavita Singh', 'Oral surgeon', 'on_call', '+919000000006') returning id",
      [clinicId],
    );
    for (const weekday of [2, 6]) {
      await c.query(
        "insert into doctor_visiting_schedules (clinic_id, doctor_id, branch_id, weekday, start_time, end_time) values ($1, $2, $3, $4, '11:00', '17:00')",
        [clinicId, mehta, branchId, weekday],
      );
    }
    // Dr. Verma works mornings only.
    for (const weekday of [1, 2, 3, 4, 5, 6]) {
      await c.query(
        "insert into working_hours (clinic_id, branch_id, doctor_id, weekday, start_time, end_time) values ($1, $2, $3, $4, '10:00', '14:00')",
        [clinicId, branchId, verma, weekday],
      );
    }
    const chair1 = (await c.query("select id from chairs where clinic_id = $1", [clinicId])).rows[0]
      .id as string;
    await c.query("update chairs set name = 'Chair 1' where id = $1", [chair1]);
    const chair2 = await one(
      "insert into chairs (clinic_id, branch_id, name, equipment, sort_order) values ($1, $2, 'Chair 2 (surgery)', '{implant_motor}', 2) returning id",
      [clinicId, branchId],
    );
    await c.query(
      "update procedure_types set required_equipment = '{implant_motor}' where code = 'implant_surgery'",
    );
    await c.query(
      "update procedure_types set allowed_doctor_ids = $1 where code in ('ortho_consultation', 'ortho_adjustment')",
      [[mehta]],
    );
    await c.query("update procedure_types set allowed_doctor_ids = $1 where code = 'surgical_extraction'", [
      [sharma, singh],
    ]);
    for (const [code, [min, max]] of Object.entries(PRICES)) {
      await c.query(
        "update procedure_types set price_min_paise = $2, price_max_paise = $3, price_public = true where code = $1",
        [code, min * 100, max * 100],
      );
    }
    await c.query(
      "insert into holidays (clinic_id, date, name) values ($1, '2026-11-08', 'Diwali'), ($1, '2026-12-25', 'Christmas')",
      [clinicId],
    );
    await c.query(
      "insert into emergency_slots (clinic_id, branch_id, chair_id, weekday, start_time, duration_min) select $1, $2, $3, d, '20:00', 30 from generate_series(1, 6) d",
      [clinicId, branchId, chair1],
    );
    const procs = Object.fromEntries(
      (await c.query("select code, id from procedure_types")).rows.map((r) => [r.code, r.id as string]),
    );
    return { sharma, verma, mehta, prasad, chair1, chair2, procs };
  });

  const random = rng(42);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;

  const patients = await withClinic(pool, ctx, async (c) => {
    const list: { id: string; name: string }[] = [];
    for (let i = 0; i < 80; i++) {
      const female = random() < 0.5;
      const name = `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`;
      const phone = `+9190000${String(10000 + i * 37).padStart(5, "0")}`;
      const p = await createPatient(c, {
        name,
        phone,
        gender: female ? "female" : "male",
        approxBirthYear: 1950 + Math.floor(random() * 60),
        city: `${pick(AREAS)}, Ranchi`,
        source: pick(SOURCES),
        fileNumber: `SDC-${1000 + i}`,
      });
      list.push({ id: p.id, name });
    }
    // Families sharing the head of family's phone.
    for (let f = 0; f < 6; f++) {
      const head = list[f * 5]!;
      const headPhone = (await c.query("select phone from patients where id = $1", [head.id])).rows[0].phone;
      const child = await createPatient(c, {
        name: `${pick(["Aarav", "Ananya", "Riya", "Kabir", "Ishaan", "Diya"])} ${head.name.split(" ")[1]}`,
        phone: headPhone,
        approxBirthYear: 2014 + f,
        gender: f % 2 ? "male" : "female",
      });
      await linkFamily(c, {
        patientId: head.id,
        relatedPatientId: child.id,
        relationship: f % 2 ? "son" : "daughter",
      });
      list.push({ id: child.id, name: child.name });
    }
    return list;
  });

  // Past 60 days of visits (completed, some no-shows) and the coming 7 days of bookings.
  const today = localDateOf(now, TZ);
  const general = [
    "consultation",
    "scaling",
    "filling",
    "rct_sitting",
    "extraction",
    "crown_prep",
    "followup",
    "xray_iopa",
  ];
  const slots = [
    10 * 60,
    10 * 60 + 30,
    11 * 60 + 15,
    12 * 60,
    12 * 60 + 45,
    17 * 60,
    17 * 60 + 45,
    18 * 60 + 30,
    19 * 60 + 15,
  ];
  let booked = 0;
  for (let offset = -60; offset <= 7; offset++) {
    const date = addDays(today, offset);
    const weekday = weekdayOf(date);
    // Today gets a fixed, realistic day (below) instead of random bookings.
    if (weekday === 0 || offset === 0) continue;
    const perDay = offset < 0 ? 3 + Math.floor(random() * 3) : 5 + Math.floor(random() * 4);
    const used = new Set<string>();
    for (let n = 0; n < perDay; n++) {
      const startMin = pick(slots);
      const isOrtho =
        (weekday === 2 || weekday === 6) && random() < 0.3 && startMin >= 11 * 60 && startMin < 16 * 60;
      const code = isOrtho ? "ortho_adjustment" : pick(general);
      const doctorId = isOrtho ? ids.mehta : startMin < 14 * 60 && random() < 0.5 ? ids.verma : ids.sharma;
      const chairId = random() < 0.5 ? ids.chair1 : ids.chair2;
      const key = `${doctorId}:${chairId}:${startMin}`;
      if (used.has(key)) continue;
      used.add(key);
      const patient = pick(patients);
      try {
        await withClinic(pool, ctx, async (c) => {
          const { appointment } = await bookDirect(c, {
            branchId,
            patientId: patient.id,
            doctorId,
            chairId,
            procedureTypeId: ids.procs[code],
            startsAt: zonedInstant(date, startMin, TZ),
            acknowledgeWarnings: true,
            source: random() < 0.2 ? "walk_in" : "staff",
            now,
          });
          if (offset < 0)
            await setAppointmentStatus(c, appointment.id, random() < 0.1 ? "no_show" : "completed");
        });
        booked++;
      } catch {
        // Clash with another random booking: skip, the demo does not need it.
      }
    }
  }
  const day = await withClinic(pool, ctx, (c) => seedDemoToday(c, { branchId, ids, patients, now }));
  booked += day.booked;
  // Chats, calls and leads happen in clinic hours: at night the demo shows them from the evening before.
  const anchor = clinicMoment(now);
  await withClinic(pool, ctx, (c) => seedDemoChats(c, anchor));
  await withClinic(pool, ctx, (c) => seedDemoCalls(c, anchor));
  await withClinic(pool, ctx, (c) => seedDemoPlans(c, now));
  await withClinic(pool, ctx, (c) => seedDemoClinical(c, now));
  await withClinic(pool, ctx, (c) => seedDemoMoney(c, now, day.unbilled));
  await withClinic(pool, ctx, (c) => seedDemoLeads(c, anchor));
  await withClinic(pool, ctx, (c) => seedBookingDates(c, now));
  await seedDemoWallet(pool, clinicId, now);
  console.log(`Demo clinic ready: ${patients.length} patients, ${booked} appointments.`);
  return clinicId;
}

export async function seedDemoCommand(args: string[]) {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = createPool(url, { max: 4 });
  try {
    if (args.includes("--reset")) await reset(pool);
    // --at=12:10 loads today as it would look at 12:10 (for demos given outside clinic hours).
    const at = args.find((a) => a.startsWith("--at="))?.slice(5);
    const now =
      at && /^\d{1,2}:\d{2}$/.test(at)
        ? zonedInstant(
            localDateOf(new Date(), TZ),
            Number(at.split(":")[0]) * 60 + Number(at.split(":")[1]),
            TZ,
          )
        : new Date();
    const arg = (name: string) =>
      args
        .find((a) => a.startsWith(`--${name}=`))
        ?.slice(name.length + 3)
        .toLowerCase();
    const emails = {
      owner: arg("owner-email") ?? DEMO_OWNER_EMAIL,
      reception: arg("reception-email") ?? DEMO_RECEPTION_EMAIL,
    };
    const id = await seedDemo(pool, now, emails);
    console.log(`Clinic id: ${id}`);
    console.log(`Owner login: ${emails.owner} · Reception login: ${emails.reception}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("seed-demo.ts")) {
  seedDemoCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}

export type { PoolClient };

/** Two WhatsApp chats so the inbox is not empty: a booking in progress, and a patient asking for a call. */
async function seedDemoChats(c: PoolClient, now: Date) {
  const { rows } = await c.query(
    "select id, name, phone from patients where phone is not null order by created_at limit 2",
  );
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  const chats = [
    {
      patient: rows[0],
      messages: [
        ["in", "patient", "Hi, kal dant mein dard hai, appointment chahiye", 42],
        ["out", "bot", "Namaste! Kal ke liye yeh time khaali hain. Kaunsa theek rahega?", 41],
        ["in", "patient", "Kitna kharcha hoga RCT ka?", 5],
      ],
      task: null,
    },
    {
      patient: rows[1],
      messages: [
        ["in", "patient", "Please call me back about my bill", 20],
        ["out", "bot", "Sure, someone from the clinic will call you soon.", 19],
      ],
      task: { kind: "callback", priority: "high", title: "Patient asked for a call back about a bill" },
    },
  ];
  for (const chat of chats) {
    if (!chat.patient) continue;
    const last = chat.messages[chat.messages.length - 1]!;
    const lastIn = [...chat.messages].reverse().find((m) => m[0] === "in")!;
    const conv = await c.query(
      `insert into conversations (clinic_id, channel, phone, patient_id, last_inbound_at, last_message_at, last_preview, unread_count)
       values (app.current_clinic_id(), 'whatsapp', $1, $2, $3, $4, $5, 1) returning id`,
      [chat.patient.phone, chat.patient.id, at(lastIn[3] as number), at(last[3] as number), last[2]],
    );
    for (const [direction, author, body, minutesAgo] of chat.messages)
      await c.query(
        `insert into messages (clinic_id, conversation_id, direction, author, kind, body, status, created_at)
         values (app.current_clinic_id(), $1, $2, $3, 'text', $4, $5, $6)`,
        [
          conv.rows[0].id,
          direction,
          author,
          body,
          direction === "in" ? "received" : "read",
          at(minutesAgo as number),
        ],
      );
    if (chat.task)
      await c.query(
        `insert into tasks (clinic_id, kind, priority, title, patient_id, conversation_id, created_by)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, 'assistant')`,
        [chat.task.kind, chat.task.priority, chat.task.title, chat.patient.id, conv.rows[0].id],
      );
  }
}

/** Two phone calls handled by the assistant, so the Calls screen has something to show. */
async function seedDemoCalls(c: PoolClient, now: Date) {
  await c.query(
    "insert into clinic_channels (clinic_id, kind, external_id, display_phone) values (app.current_clinic_id(), 'voice', '+918047100000', '+918047100000') on conflict do nothing",
  );
  const { rows } = await c.query(
    "select id, name, phone from patients where phone is not null order by created_at offset 2 limit 2",
  );
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  const calls = [
    {
      patient: rows[0],
      outcome: "booked",
      summary: `Booked ${rows[0]?.name} for tomorrow at 5 PM (Consultation)`,
      minutesAgo: 90,
      duration: 96,
      turns: [
        [
          "assistant",
          "नमस्ते, Demo Dental में फ़ोन करने के लिए धन्यवाद। मैं क्लिनिक की डिजिटल असिस्टेंट हूँ। बताइए, मैं आपकी क्या मदद कर सकती हूँ?",
          null,
        ],
        ["caller", "मुझे कल शाम को चेकअप के लिए आना है", null],
        ["assistant", "परामर्श के लिए कल शाम 5 बजे या कल शाम साढ़े 6 बजे खाली है। कौन-सा ठीक रहेगा?", 820],
        ["caller", "पहला वाला", null],
        ["assistant", "तो कल शाम 5 बजे, Dr. Rakesh Sharma के साथ। बुक कर दूँ?", 640],
        ["caller", "हाँ", null],
        [
          "assistant",
          "हो गया! Appointment कल शाम 5 बजे के लिए बुक हो गया है। आपको WhatsApp पर confirmation मिल जाएगा।",
          910,
        ],
      ],
    },
    {
      patient: rows[1],
      outcome: "emergency",
      summary: "Emergency transfer: Urgent: facial swelling",
      minutesAgo: 30,
      duration: 41,
      turns: [
        [
          "assistant",
          "नमस्ते, Demo Dental में फ़ोन करने के लिए धन्यवाद। बताइए, मैं आपकी क्या मदद कर सकती हूँ?",
          null,
        ],
        ["caller", "gaal mein bahut sujan aa gayi hai", null],
        [
          "assistant",
          "इसमें जल्दी ध्यान देना ज़रूरी है। मैं आपको तुरंत डॉक्टर से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।",
          700,
        ],
      ],
    },
  ];
  for (const [i, call] of calls.entries()) {
    if (!call.patient) continue;
    const { rows: made } = await c.query(
      `insert into calls (clinic_id, provider, provider_call_id, from_phone, to_phone, patient_id, route, status, outcome,
                          language, summary, started_at, answered_at, ended_at, duration_sec, latency, usage,
                          transfer_kind)
       values (app.current_clinic_id(), 'fake-telephony', $1, $2, '+918047100000', $3, 'assistant', 'ended', $4,
               'hi-IN', $5, $6, $6, $7, $8, '{"p50": 820, "p95": 910, "max": 910, "turns": 3}', '{"stt_ms": 9000, "tts_chars": 420}', $9)
       returning id`,
      [
        `demo-call-${i}-${now.getTime()}`,
        call.patient.phone,
        call.patient.id,
        call.outcome,
        call.summary,
        at(call.minutesAgo),
        at(call.minutesAgo - 2),
        call.duration,
        call.outcome === "emergency" ? "emergency" : null,
      ],
    );
    for (const [seq, [speaker, text, latency]] of call.turns.entries())
      await c.query(
        "insert into call_turns (clinic_id, call_id, seq, speaker, text, latency_ms, flags) values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6)",
        [
          made[0].id,
          seq + 1,
          speaker,
          text,
          latency,
          call.outcome === "emergency" && speaker === "assistant" && seq > 0 ? ["emergency"] : [],
        ],
      );
  }
}

/** Treatment plans in different states, so "Incomplete treatments" shows real rupee values. */
async function seedDemoPlans(c: PoolClient, now: Date) {
  const prices: Record<string, number> = {
    rct_sitting: 350000,
    crown_prep: 450000,
    crown_fitting: 450000,
    implant_surgery: 2500000,
    implant_followup: 100000,
    extraction: 120000,
    followup: 30000,
  };
  for (const [code, paise] of Object.entries(prices))
    await c.query(
      "update procedure_types set price_min_paise = coalesce(price_min_paise, $2), price_max_paise = coalesce(price_max_paise, $2) where code = $1",
      [code, paise],
    );
  const templates = new Map(
    (await c.query("select id, code from treatment_templates")).rows.map((r) => [
      r.code as string,
      r.id as string,
    ]),
  );
  const { rows: patients } = await c.query("select id from patients order by created_at offset 10 limit 5");
  const today = localDateOf(now, TZ);
  const plans: [string, number, "accepted" | "proposed"][] = [
    ["rct_crown", -20, "accepted"],
    ["implant", -40, "accepted"],
    ["rct", -3, "accepted"],
    ["extraction", 2, "accepted"],
    ["rct_crown", 5, "proposed"],
  ];
  for (const [i, [code, offset, status]] of plans.entries()) {
    const patient = patients[i];
    const templateId = templates.get(code);
    if (!patient || !templateId) continue;
    await createTreatmentPlan(c, {
      patientId: patient.id,
      templateId,
      startDate: addDays(today, offset),
      status,
      now,
    });
  }
  if (patients[4]) {
    const plan = (await c.query("select id from treatment_plans where patient_id = $1", [patients[4].id]))
      .rows[0];
    if (plan) await estimateFromPlan(c, plan.id, { now });
  }
}

/** Bills for recent visits: most paid in full at the desk, some part-paid (dues), a few by payment link. */
async function seedDemoMoney(c: PoolClient, now: Date, unbilled: string[] = []) {
  const { rows } = await c.query(
    `select a.id, a.patient_id, a.ends_at, pt.id as procedure_id, pt.name, coalesce(pt.price_min_paise, 50000) as price
     from appointments a join procedure_types pt on pt.id = a.procedure_type_id
     where a.status = 'completed' and a.ends_at > $1::timestamptz - interval '30 days' and a.ends_at < $1
       and not (a.id = any($2::uuid[]))
     order by a.ends_at desc limit 60`,
    [now, unbilled],
  );
  const methods = ["cash", "upi", "upi", "card", "cash"] as const;
  for (const [i, a] of rows.entries()) {
    const price = Number(a.price);
    await addCharge(c, {
      patientId: a.patient_id,
      amountPaise: price,
      description: a.name,
      procedureTypeId: a.procedure_id,
      appointmentId: a.id,
      at: a.ends_at,
    });
    // Every seventh visit is left part-paid, so the dues list has people on it.
    const paid = i % 7 === 3 ? Math.round(price / 2 / 100) * 100 : price;
    await recordPayment(c, {
      patientId: a.patient_id,
      amountPaise: paid,
      method: methods[i % methods.length]!,
      reference: methods[i % methods.length] === "upi" ? `UPI${100200 + i}` : null,
      appointmentId: a.id,
      now: new Date(a.ends_at.getTime() + 5 * 60_000),
    });
  }
}

/**
 * The Sentio side for the demo: billing on, an opening balance, and a month of metered usage (calls and
 * WhatsApp messages), so the wallet page and the Sentio admin panel have something to show.
 */
async function seedDemoWallet(pool: Pool, clinicId: string, now: Date) {
  await pool.query(
    "insert into wallet_credits (clinic_id, kind, amount_paise, note) values ($1, 'opening', 500000, 'Demo opening balance')",
    [clinicId],
  );
  await withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    for (let d = 1; d <= 25; d++) {
      const at = new Date(now.getTime() - d * 86_400_000);
      for (let n = 0; n < 4; n++) {
        const ref = `demo-${d}-${n}`;
        await meter(c, { kind: "telephony_min", quantity: 2 + ((d + n) % 4), refType: "call", ref, at });
        await meter(c, { kind: "stt_sec", quantity: 40 + ((d * 7 + n) % 60), refType: "call", ref, at });
        await meter(c, { kind: "tts_char", quantity: 600 + ((d * 13 + n) % 400), refType: "call", ref, at });
        await meter(c, { kind: "wa_utility", quantity: 1, refType: "outbox", ref, at });
      }
    }
  });
  await pool.query("update wallets set enforced = true where clinic_id = $1", [clinicId]);
}

/** A few leads from ads and other sources, in different stages, for the Leads page. */
async function seedDemoLeads(c: PoolClient, now: Date) {
  const hours = (h: number) => new Date(now.getTime() - h * 3600_000);
  const leads: Parameters<typeof createLead>[1][] = [
    {
      source: "meta_form",
      externalId: "demo-1",
      name: "Anjali Mishra",
      phone: "+919811100001",
      campaign: "Braces - Sept",
      need: "braces",
      timing: "week",
      answers: { "which_treatment?": "Braces for my son" },
      now: hours(0.2),
    },
    {
      source: "ctwa",
      externalId: "demo-2",
      name: "Rakesh Yadav",
      phone: "+919811100002",
      campaign: "Implants in Ranchi",
      need: "implant",
      alreadyTalking: true,
      now: hours(1),
    },
    {
      source: "meta_form",
      externalId: "demo-3",
      name: "Pooja Sinha",
      phone: "+919811100003",
      campaign: "Free check-up",
      need: "cleaning",
      timing: "month",
      answers: { "which_treatment?": "Cleaning" },
      now: hours(5),
    },
    {
      source: "justdial",
      name: "Vikash Oraon",
      phone: "+919811100004",
      need: "pain",
      notes: "Called about wisdom tooth pain",
      now: hours(26),
    },
    {
      source: "meta_form",
      externalId: "demo-5",
      name: "Neelam Kumari",
      phone: "+919811100005",
      campaign: "Free check-up",
      need: "cleaning",
      timing: "exploring",
      answers: { "which_treatment?": "Just want to know prices" },
      now: hours(50),
    },
  ];
  const ids: string[] = [];
  for (const l of leads) ids.push((await createLead(c, l)).id);
  // One the front desk already called: not interested.
  await recordCallOutcome(c, ids[4]!, {
    outcome: "not_interested",
    note: "Went to a clinic nearer home",
    now: hours(30),
  });
}

/** "Now" for things that only happen in clinic hours; at night, 8:30 pm the evening before (or this evening). */
function clinicMoment(now: Date): Date {
  const minutes = localMinutesOf(now, TZ);
  const today = localDateOf(now, TZ);
  if (minutes >= 9 * 60 + 30 && minutes <= 21 * 60) return now;
  return zonedInstant(minutes < 9 * 60 + 30 ? addDays(today, -1) : today, 20 * 60 + 30, TZ);
}

interface DemoIds {
  sharma: string;
  verma: string;
  mehta: string;
  chair1: string;
  chair2: string;
  procs: Record<string, string>;
}

/**
 * Today as a real clinic day: two doctors in the morning, one in the evening, the orthodontist on his
 * visiting days. What has happened depends on the time the demo is loaded: earlier visits are done (and
 * billed, one left unbilled for the desk to settle), the current one is with the doctor, patients due
 * soon are waiting with tokens, and walk-ins wait in the queue while the clinic is open.
 */
async function seedDemoToday(
  c: PoolClient,
  input: { branchId: string; ids: DemoIds; patients: { id: string; name: string }[]; now: Date },
): Promise<{ booked: number; unbilled: string[] }> {
  const { ids, now } = input;
  const today = localDateOf(now, TZ);
  const weekday = weekdayOf(today);
  if (weekday === 0) return { booked: 0, unbilled: [] };
  const plan: [number, "sharma" | "verma" | "mehta", 1 | 2, string, "staff" | "whatsapp" | "voice"][] = [
    [10 * 60, "sharma", 1, "consultation", "voice"],
    [10 * 60, "verma", 2, "extraction", "staff"],
    [10 * 60 + 30, "sharma", 1, "scaling", "whatsapp"],
    [10 * 60 + 45, "verma", 2, "filling", "staff"],
    [11 * 60 + 15, "sharma", 1, "filling", "staff"],
    [11 * 60 + 30, "verma", 2, "consultation", "whatsapp"],
    [12 * 60, "sharma", 1, "rct_sitting", "staff"],
    [12 * 60 + 15, "verma", 2, "scaling", "voice"],
    [13 * 60, "verma", 2, "crown_prep", "staff"],
    [13 * 60 + 15, "sharma", 1, "xray_iopa", "staff"],
    [17 * 60, "sharma", 1, "consultation", "whatsapp"],
    [17 * 60 + 30, "sharma", 1, "filling", "staff"],
    [18 * 60 + 15, "sharma", 1, "extraction", "voice"],
    [19 * 60, "sharma", 1, "followup", "staff"],
    [19 * 60 + 30, "sharma", 1, "scaling", "whatsapp"],
    [20 * 60, "sharma", 1, "consultation", "staff"],
  ];
  if (weekday === 2 || weekday === 6)
    for (const m of [14 * 60 + 30, 15 * 60 + 15, 16 * 60])
      plan.push([m, "mehta", 2, "ortho_adjustment", "staff"]);
  plan.sort((a, b) => a[0] - b[0]);

  // Different people all day (the random names repeat now and then).
  const seen = new Set<string>();
  const people = input.patients.slice(0, 70).filter((p) => !seen.has(p.name) && seen.add(p.name));
  const nowMin = localMinutesOf(now, TZ);
  const minute = 60_000;
  let booked = 0;
  let pastIndex = 0;
  const unbilled: string[] = [];
  for (const [i, [startMin, doctor, chair, code, source]] of plan.entries()) {
    const patient = people[i % people.length]!;
    let appointment;
    try {
      ({ appointment } = await bookDirect(c, {
        branchId: input.branchId,
        patientId: patient.id,
        doctorId: ids[doctor],
        chairId: chair === 1 ? ids.chair1 : ids.chair2,
        procedureTypeId: ids.procs[code],
        startsAt: zonedInstant(today, startMin, TZ),
        acknowledgeWarnings: true,
        now: new Date(now.getTime() - 3 * 86_400_000),
      }));
    } catch {
      continue;
    }
    booked++;
    if (source !== "staff")
      await c.query("update appointments set source = $2 where id = $1", [appointment.id, source]);
    const endMin = startMin + (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / minute;
    const steps: ("confirmed" | "checked_in" | "in_chair" | "completed" | "no_show")[] = [];
    if (endMin <= nowMin) {
      pastIndex++;
      if (pastIndex === 4) steps.push("no_show");
      else steps.push("checked_in", "in_chair", "completed");
      if (pastIndex === 2) unbilled.push(appointment.id);
    } else if (startMin <= nowMin) steps.push("checked_in", "in_chair");
    else if (startMin - 40 <= nowMin) steps.push("confirmed", "checked_in");
    else if (i % 2 === 0) steps.push("confirmed");
    for (const step of steps) await setAppointmentStatus(c, appointment.id, step);
  }
  // Queue times as they would have been: arrived a few minutes early, called in at the booked time.
  await c.query(
    `update queue_entries q set
       arrived_at = case when q.status = 'waiting' then $1::timestamptz - make_interval(mins => 4 + (q.token * 3) % 11)
                         else a.starts_at - make_interval(mins => 5 + (q.token * 7) % 10) end,
       called_at = case when q.status = 'waiting' then null else a.starts_at + make_interval(mins => (q.token * 3) % 6) end,
       finished_at = case when q.status = 'done' then a.ends_at else null end
     from appointments a where a.id = q.appointment_id and q.day = $2`,
    [now, today],
  );
  // Walk-ins waiting while the clinic is open.
  if ((nowMin >= 10 * 60 && nowMin < 14 * 60) || (nowMin >= 17 * 60 && nowMin < 21 * 60)) {
    const walkIns: [number, string | null, string][] = [
      [70, ids.sharma, "Tooth pain since last night"],
      [71, null, "Bleeding gums, wants a check-up"],
    ];
    for (const [k, doctorId, note] of walkIns)
      await addWalkIn(c, { patientId: input.patients[k]!.id, doctorId, note, now });
    await c.query(
      "update queue_entries set arrived_at = $1::timestamptz - make_interval(mins => 6 + (token % 3) * 9) where day = $2 and appointment_id is null",
      [now, today],
    );
  }
  return { booked, unbilled };
}

/**
 * Bookings are made days ahead, not all at the moment the demo is loaded. A few of the coming days'
 * bookings were made by the assistant today, as on a normal day.
 */
async function seedBookingDates(c: PoolClient, now: Date) {
  await c.query(
    `update appointments set created_at = least(starts_at, $1::timestamptz) - make_interval(days => 1 + abs(hashtext(id::text)) % 6)
     where source <> 'import'`,
    [now],
  );
  const since = zonedInstant(localDateOf(now, TZ), 9 * 60, TZ);
  if (now.getTime() - since.getTime() < 60 * 60_000) return;
  const { rows } = await c.query(
    `select id from appointments where starts_at > $1::timestamptz + interval '1 day' and status = 'booked'
     order by starts_at limit 3`,
    [now],
  );
  for (const [i, r] of rows.entries())
    await c.query("update appointments set source = $2, created_at = $3 where id = $1", [
      r.id,
      i === 1 ? "voice" : "whatsapp",
      new Date(now.getTime() - (20 + i * 70) * 60_000),
    ]);
}

/**
 * The doctor's side: registration numbers for prescriptions, the doctors' usual prescriptions as
 * templates, and a few past visits with notes, tooth-chart findings and a prescription.
 */
async function seedDemoClinical(c: PoolClient, now: Date) {
  await c.query(
    `update doctors set qualification = v.q, registration_no = v.r
     from (values ('Dr. Rakesh Sharma', 'BDS, MDS (Oral Surgery)', 'JH-A-1123'),
                  ('Dr. Neha Verma', 'BDS', 'JH-A-2087'),
                  ('Dr. Amit Mehta', 'BDS, MDS (Orthodontics)', 'BR-A-3310'),
                  ('Dr. Sunil Prasad', 'BDS, MDS (Endodontics)', 'JH-A-1790'),
                  ('Dr. Kavita Singh', 'BDS, MDS (Oral Surgery)', 'JH-A-2544')) as v(n, q, r)
     where doctors.name = v.n`,
  );
  const sharma = (await c.query("select id from doctors where name = 'Dr. Rakesh Sharma'")).rows[0]
    .id as string;
  const templates: [string, RxItem[], string][] = [
    [
      "After extraction",
      [
        {
          drug: "Amoxicillin 500 mg",
          dose: "1 capsule",
          frequency: "1-1-1",
          duration: "5 days",
          instructions: "After food",
        },
        {
          drug: "Aceclofenac 100 mg + Paracetamol 325 mg",
          dose: "1 tablet",
          frequency: "1-0-1",
          duration: "3 days",
          instructions: "After food",
        },
        {
          drug: "Pantoprazole 40 mg",
          dose: "1 tablet",
          frequency: "1-0-0",
          duration: "5 days",
          instructions: "Before breakfast",
        },
      ],
      "Bite on the gauze for 30 minutes. Cold, soft food today. No spitting, no hot drinks, no smoking for 24 hours.",
    ],
    [
      "After root canal",
      [
        {
          drug: "Ibuprofen 400 mg",
          dose: "1 tablet",
          frequency: "SOS (when needed)",
          duration: "3 days",
          instructions: "After food",
        },
      ],
      "Avoid chewing on this side until the crown is placed.",
    ],
    [
      "Sensitivity",
      [
        {
          drug: "Potassium nitrate toothpaste",
          frequency: "Twice a day",
          duration: "1 month",
          instructions: "Leave on the teeth for 1 minute",
        },
      ],
      "Use a soft brush. Avoid very cold drinks for two weeks.",
    ],
  ];
  for (const [name, items, advice] of templates)
    await saveRxTemplate(c, { name, doctorId: sharma, items, advice });

  // Three patients with a past visit on record.
  const visits = (
    await c.query(
      `select a.id, a.patient_id, a.doctor_id, a.starts_at, pt.code
       from appointments a join procedure_types pt on pt.id = a.procedure_type_id
       where a.status = 'completed' and pt.code in ('extraction', 'rct_sitting', 'scaling') and a.starts_at < $1
       order by a.starts_at desc limit 3`,
      [now],
    )
  ).rows;
  for (const v of visits) {
    const note =
      v.code === "extraction"
        ? {
            complaint: "Pain and swelling, lower right back tooth",
            findings: "Grossly decayed 46, tender on percussion",
            diagnosis: "Non-restorable 46",
            treatment: "Extraction of 46 under LA",
            advice: "Post-extraction instructions given",
          }
        : v.code === "rct_sitting"
          ? {
              complaint: "Night pain upper left",
              findings: "Deep caries 26, lingering pain on cold",
              diagnosis: "Irreversible pulpitis 26",
              treatment: "Access opening and cleaning, RCT sitting 1",
              advice: "Next sitting in one week",
            }
          : {
              complaint: "Bleeding gums while brushing",
              findings: "Generalised calculus, gingivitis",
              diagnosis: "Chronic gingivitis",
              treatment: "Scaling and polishing",
              advice: "Brush twice, floss daily",
            };
    await saveNote(c, { patientId: v.patient_id, appointmentId: v.id, doctorId: v.doctor_id, ...note });
    const teeth: [number, ToothCondition][] =
      v.code === "extraction"
        ? [
            [46, "missing"],
            [36, "caries"],
            [48, "impacted"],
          ]
        : v.code === "rct_sitting"
          ? [
              [26, "rct"],
              [16, "filled"],
            ]
          : [
              [31, "healthy"],
              [17, "caries"],
            ];
    for (const [tooth, condition] of teeth)
      await recordTooth(c, { patientId: v.patient_id, tooth, condition, appointmentId: v.id });
    if (v.code === "extraction") {
      const tpl = templates[0]!;
      await writePrescription(c, {
        patientId: v.patient_id,
        doctorId: v.doctor_id,
        appointmentId: v.id,
        items: tpl[1],
        advice: tpl[2],
        now: new Date(v.starts_at.getTime() + 20 * 60_000),
      });
    }
  }
}

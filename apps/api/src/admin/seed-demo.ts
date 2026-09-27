/* eslint-disable no-console -- command-line tool output */
/**
 * Creates "Sharma Dental Clinic (Demo)" for sales demos and end-to-end tests: Hindi names, fictional Indian
 * numbers (+91 90000 xxxxx), visiting consultants, family links, past visits and this week's schedule.
 *
 *   DATABASE_URL=... pnpm --filter @dentalos/api seed:demo            # create if missing
 *   DATABASE_URL=... pnpm --filter @dentalos/api seed:demo -- --reset # delete the demo clinic and recreate
 */
import {
  addDays,
  bookDirect,
  createClinic,
  createPatient,
  linkFamily,
  localDateOf,
  setAppointmentStatus,
  weekdayOf,
  zonedInstant,
} from "@dentalos/core";
import { createPool, withClinic, type Pool, type PoolClient } from "@dentalos/db";

export const DEMO_NAME = "Sharma Dental Clinic (Demo)";
export const DEMO_OWNER_PHONE = "+919000000001";
export const DEMO_RECEPTION_PHONE = "+919000000002";
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
  for (const { id } of rows) {
    // Order matters: appointments reference patients, doctors and chairs without cascading.
    await pool.query("delete from slot_holds where clinic_id = $1", [id]);
    await pool.query("delete from appointments where clinic_id = $1", [id]);
    await pool.query("delete from clinics where id = $1", [id]);
  }
  await pool.query("delete from resource_occupancy where clinic_id = any($1)", [rows.map((r) => r.id)]);
}

export async function seedDemo(pool: Pool, now = new Date()): Promise<string> {
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
      owner: { name: "Dr. Rakesh Sharma", phone: DEMO_OWNER_PHONE },
    }));
    await client.query(
      "update clinics set address = 'Shop 12, Main Road, Lalpur', state = 'Jharkhand', pincode = '834001', maps_url = 'https://maps.google.com/?q=Lalpur+Ranchi' where id = $1",
      [clinicId],
    );
    await client.query(
      "insert into clinic_memberships (clinic_id, invited_phone, display_name, role) values ($1, $2, 'Priya (Reception)', 'receptionist')",
      [clinicId, DEMO_RECEPTION_PHONE],
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
    if (weekday === 0) continue;
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
          else if (offset === 0 && startMin < 12 * 60)
            await setAppointmentStatus(c, appointment.id, "checked_in");
        });
        booked++;
      } catch {
        // Clash with another random booking: skip, the demo does not need it.
      }
    }
  }
  console.log(`Demo clinic ready: ${patients.length} patients, ${booked} appointments.`);
  return clinicId;
}

export async function seedDemoCommand(args: string[]) {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = createPool(url, { max: 4 });
  try {
    if (args.includes("--reset")) await reset(pool);
    const id = await seedDemo(pool);
    console.log(`Clinic id: ${id}`);
    console.log(`Owner login: ${DEMO_OWNER_PHONE} · Reception login: ${DEMO_RECEPTION_PHONE}`);
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

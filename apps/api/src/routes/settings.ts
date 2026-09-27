import { sequential } from "@dentalos/core";
import type { PoolClient } from "@dentalos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clockTime, HttpError, idParams, instant, localDate, parse, uuid } from "../http";
import type { StaffContextService } from "../staff-context";

/** Builds "col = $n" pairs for a PATCH from an allow-list of camelCase → column names. */
function updateSql(body: Record<string, unknown>, columns: Record<string, string>, firstIndex = 2) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in body) || body[key] === undefined) continue;
    values.push(body[key]);
    sets.push(`${column} = $${firstIndex + values.length - 1}`);
  }
  return { sets, values };
}

async function patchRow(
  client: PoolClient,
  table: string,
  id: string,
  body: Record<string, unknown>,
  columns: Record<string, string>,
) {
  const { sets, values } = updateSql(body, columns);
  if (sets.length === 0) throw new HttpError(400, "invalid_input", "Nothing to update");
  const { rows } = await client.query(`update ${table} set ${sets.join(", ")} where id = $1 returning *`, [
    id,
    ...values,
  ]);
  if (!rows[0]) throw new HttpError(404, "not_found", "Not found");
  return rows[0];
}

const window = z
  .object({ weekday: z.number().int().min(0).max(6), start: clockTime, end: clockTime })
  .refine((w) => w.end > w.start, {
    message: "end must be after start",
  });

const doctorBody = z.object({
  name: z.string().trim().min(1).max(100),
  speciality: z.string().trim().max(100).nullish(),
  kind: z.enum(["permanent", "visiting", "on_call"]).default("permanent"),
  phone: z.string().trim().max(20).nullish(),
  emergencyOrder: z.number().int().min(1).max(20).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  active: z.boolean().optional(),
  // Printed on prescriptions.
  qualification: z.string().trim().max(100).nullish(),
  registrationNo: z.string().trim().max(50).nullish(),
});
const DOCTOR_COLUMNS = {
  name: "name",
  speciality: "speciality",
  kind: "kind",
  phone: "phone",
  emergencyOrder: "emergency_order",
  color: "color",
  active: "active",
  qualification: "qualification",
  registrationNo: "registration_no",
};

const chairBody = z.object({
  branchId: uuid.optional(),
  name: z.string().trim().min(1).max(50),
  equipment: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const CHAIR_COLUMNS = { name: "name", equipment: "equipment", active: "active", sortOrder: "sort_order" };

const paise = z.number().int().min(0).max(100_000_000);
const procedureBody = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(40),
  name: z.string().trim().min(1).max(100),
  nameHi: z.string().trim().max(100).nullish(),
  synonyms: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  category: z.string().max(40).nullish(),
  defaultDurationMin: z.number().int().min(5).max(480),
  bufferAfterMin: z.number().int().min(0).max(120).default(0),
  requiredEquipment: z.array(z.string()).max(10).default([]),
  allowedDoctorIds: z.array(uuid).max(20).default([]),
  priceMinPaise: paise.nullish(),
  priceMaxPaise: paise.nullish(),
  pricePublic: z.boolean().default(false),
  gstMode: z.enum(["exempt", "taxable"]).default("exempt"),
  gstRateBps: z.number().int().min(0).max(2800).default(0),
  sacCode: z.string().max(10).nullish(),
  isConsultation: z.boolean().default(false),
  requiresLabReceived: z.boolean().default(false),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  recallMonths: z.number().int().min(1).max(36).nullish(),
  checkin: z.boolean().optional(),
  // After-care wording is clinical advice: it is only sent once a doctor marks it approved.
  aftercare: z
    .object({ en: z.string().trim().max(900), hi: z.string().trim().max(900), approved: z.boolean() })
    .nullish(),
  depositPaise: paise.nullish(),
});
const PROCEDURE_COLUMNS = {
  name: "name",
  nameHi: "name_hi",
  synonyms: "synonyms",
  category: "category",
  defaultDurationMin: "default_duration_min",
  bufferAfterMin: "buffer_after_min",
  requiredEquipment: "required_equipment",
  allowedDoctorIds: "allowed_doctor_ids",
  priceMinPaise: "price_min_paise",
  priceMaxPaise: "price_max_paise",
  pricePublic: "price_public",
  gstMode: "gst_mode",
  gstRateBps: "gst_rate_bps",
  sacCode: "sac_code",
  isConsultation: "is_consultation",
  requiresLabReceived: "requires_lab_received",
  active: "active",
  sortOrder: "sort_order",
  recallMonths: "recall_months",
  checkin: "checkin",
  aftercare: "aftercare",
  depositPaise: "deposit_paise",
};

const clinicPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().max(200).nullable(),
    gstin: z
      .string()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
      .nullable(),
    phone: z.string().max(20).nullable(),
    email: z.string().email().nullable(),
    address: z.string().max(300).nullable(),
    city: z.string().max(80).nullable(),
    state: z.string().max(80).nullable(),
    pincode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
    mapsUrl: z.string().url().nullable(),
    defaultLanguage: z.string().max(10),
    languages: z.array(z.string().max(10)).min(1).max(8),
    slotStepMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)]),
    holdMinutes: z.number().int().min(1).max(15),
    minBookingLeadMin: z.number().int().min(0).max(1440),
    bookingHorizonDays: z.number().int().min(1).max(365),
  })
  .partial();
const CLINIC_COLUMNS = {
  name: "name",
  legalName: "legal_name",
  gstin: "gstin",
  phone: "phone",
  email: "email",
  address: "address",
  city: "city",
  state: "state",
  pincode: "pincode",
  mapsUrl: "maps_url",
  defaultLanguage: "default_language",
  languages: "languages",
  slotStepMin: "slot_step_min",
  holdMinutes: "hold_minutes",
  minBookingLeadMin: "min_booking_lead_min",
  bookingHorizonDays: "booking_horizon_days",
};

async function defaultBranch(client: PoolClient, branchId?: string) {
  if (branchId) return branchId;
  const { rows } = await client.query("select id from branches order by is_default desc, name limit 1");
  if (!rows[0]) throw new HttpError(400, "invalid_input", "Clinic has no branch");
  return rows[0].id as string;
}

export function settingsRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  const read = (
    request: Parameters<StaffContextService["inClinic"]>[0],
    fn: (c: PoolClient) => Promise<unknown>,
  ) => deps.staff.inClinic(request, undefined, fn);
  const manage = (
    request: Parameters<StaffContextService["inClinic"]>[0],
    fn: (c: PoolClient) => Promise<unknown>,
  ) => deps.staff.inClinic(request, "settings.manage", fn);

  app.get("/v1/clinic", (request) =>
    read(request, async (c) => {
      const clinic = (await c.query("select * from clinics where id = app.current_clinic_id()")).rows[0];
      const branches = (
        await c.query(
          "select id, name, address, phone, maps_url, is_default from branches order by is_default desc, name",
        )
      ).rows;
      return { clinic, branches };
    }),
  );

  app.patch("/v1/clinic", (request) =>
    manage(request, async (c) => {
      const body = parse(clinicPatch, request.body);
      const { sets, values } = updateSql(body, CLINIC_COLUMNS, 1);
      if (sets.length === 0) throw new HttpError(400, "invalid_input", "Nothing to update");
      return (
        await c.query(
          `update clinics set ${sets.join(", ")} where id = app.current_clinic_id() returning *`,
          values,
        )
      ).rows[0];
    }),
  );

  // One call with everything the schedule screens need; cached on the phone for offline use.
  app.get("/v1/config", (request) =>
    read(request, async (c) => {
      const q = (sql: string) => async () => (await c.query(sql)).rows;
      const [
        clinic,
        branches,
        doctors,
        chairs,
        procedures,
        workingHours,
        breaks,
        visiting,
        holidays,
        leaves,
        emergencySlots,
      ] = await sequential(
        q(
          "select id, name, timezone, slot_step_min, hold_minutes, min_booking_lead_min, default_language, languages from clinics where id = app.current_clinic_id()",
        ),
        q("select id, name, is_default from branches order by is_default desc, name"),
        q(
          "select id, name, speciality, kind, phone, emergency_order, color, active from doctors order by active desc, created_at",
        ),
        q("select id, branch_id, name, equipment, active, sort_order from chairs order by sort_order, name"),
        q("select * from procedure_types order by active desc, sort_order, name"),
        q(
          "select id, branch_id, doctor_id, weekday, to_char(start_time, 'HH24:MI') as start, to_char(end_time, 'HH24:MI') as end from working_hours order by weekday, start_time",
        ),
        q(
          "select id, branch_id, doctor_id, weekday, to_char(start_time, 'HH24:MI') as start, to_char(end_time, 'HH24:MI') as end, label from breaks order by weekday, start_time",
        ),
        q(
          "select id, branch_id, doctor_id, weekday, to_char(start_time, 'HH24:MI') as start, to_char(end_time, 'HH24:MI') as end, valid_from::text, valid_to::text from doctor_visiting_schedules order by weekday, start_time",
        ),
        q(
          "select id, branch_id, date::text, name from holidays where date >= current_date - 7 order by date",
        ),
        q(
          "select id, doctor_id, starts_at, ends_at, reason from leaves where ends_at > now() - interval '7 days' order by starts_at",
        ),
        q(
          "select id, branch_id, chair_id, weekday, to_char(start_time, 'HH24:MI') as start, duration_min, active from emergency_slots order by weekday, start_time",
        ),
      );
      return {
        clinic: clinic[0],
        branches,
        doctors,
        chairs,
        procedures,
        workingHours,
        breaks,
        visiting,
        holidays,
        leaves,
        emergencySlots,
      };
    }),
  );

  app.post("/v1/doctors", (request) =>
    manage(request, async (c) => {
      const b = parse(doctorBody, request.body);
      const { rows } = await c.query(
        `insert into doctors (clinic_id, name, speciality, kind, phone, emergency_order, color, qualification, registration_no)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [
          b.name,
          b.speciality ?? null,
          b.kind,
          b.phone ?? null,
          b.emergencyOrder ?? null,
          b.color ?? null,
          b.qualification ?? null,
          b.registrationNo ?? null,
        ],
      );
      return rows[0];
    }),
  );
  app.patch("/v1/doctors/:id", (request) =>
    manage(request, (c) =>
      patchRow(
        c,
        "doctors",
        parse(idParams, request.params).id,
        parse(doctorBody.partial(), request.body),
        DOCTOR_COLUMNS,
      ),
    ),
  );

  // Replaces a visiting consultant's fixed days and hours.
  app.put("/v1/doctors/:id/visiting", (request) =>
    manage(request, async (c) => {
      const { id } = parse(idParams, request.params);
      const body = parse(
        z.object({
          branchId: uuid.optional(),
          windows: z
            .array(window.and(z.object({ validFrom: localDate.nullish(), validTo: localDate.nullish() })))
            .max(30),
        }),
        request.body,
      );
      const branchId = await defaultBranch(c, body.branchId);
      await c.query("delete from doctor_visiting_schedules where doctor_id = $1 and branch_id = $2", [
        id,
        branchId,
      ]);
      for (const w of body.windows) {
        await c.query(
          `insert into doctor_visiting_schedules (clinic_id, doctor_id, branch_id, weekday, start_time, end_time, valid_from, valid_to)
           values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [id, branchId, w.weekday, w.start, w.end, w.validFrom ?? null, w.validTo ?? null],
        );
      }
      return { ok: true };
    }),
  );

  app.post("/v1/chairs", (request) =>
    manage(request, async (c) => {
      const b = parse(chairBody, request.body);
      const { rows } = await c.query(
        `insert into chairs (clinic_id, branch_id, name, equipment, sort_order) values (app.current_clinic_id(), $1, $2, $3, $4) returning *`,
        [await defaultBranch(c, b.branchId), b.name, b.equipment, b.sortOrder ?? 0],
      );
      return rows[0];
    }),
  );
  app.patch("/v1/chairs/:id", (request) =>
    manage(request, (c) =>
      patchRow(
        c,
        "chairs",
        parse(idParams, request.params).id,
        parse(chairBody.partial(), request.body),
        CHAIR_COLUMNS,
      ),
    ),
  );

  const priceCheck = (b: { priceMinPaise?: number | null; priceMaxPaise?: number | null }) => {
    if (b.priceMinPaise != null && b.priceMaxPaise != null && b.priceMinPaise > b.priceMaxPaise) {
      throw new HttpError(400, "invalid_input", "Minimum price is more than maximum price");
    }
  };
  app.post("/v1/procedures", (request) =>
    manage(request, async (c) => {
      const b = parse(procedureBody, request.body);
      priceCheck(b);
      const { rows } = await c.query(
        `insert into procedure_types (clinic_id, code, name, name_hi, synonyms, category, default_duration_min, buffer_after_min,
           required_equipment, allowed_doctor_ids, price_min_paise, price_max_paise, price_public, gst_mode, gst_rate_bps, sac_code,
           is_consultation, requires_lab_received, sort_order)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning *`,
        [
          b.code,
          b.name,
          b.nameHi ?? null,
          b.synonyms,
          b.category ?? null,
          b.defaultDurationMin,
          b.bufferAfterMin,
          b.requiredEquipment,
          b.allowedDoctorIds,
          b.priceMinPaise ?? null,
          b.priceMaxPaise ?? null,
          b.pricePublic,
          b.gstMode,
          b.gstMode === "taxable" ? b.gstRateBps : 0,
          b.sacCode ?? null,
          b.isConsultation,
          b.requiresLabReceived,
          b.sortOrder ?? 0,
        ],
      );
      return rows[0];
    }),
  );
  app.patch("/v1/procedures/:id", (request) =>
    manage(request, async (c) => {
      const b = parse(procedureBody.omit({ code: true }).partial(), request.body);
      priceCheck(b);
      return patchRow(c, "procedure_types", parse(idParams, request.params).id, b, PROCEDURE_COLUMNS);
    }),
  );

  // Replaces opening hours (doctorId null = clinic hours) or breaks for one branch/doctor.
  for (const table of ["working_hours", "breaks"] as const) {
    app.put(`/v1/${table.replace("_", "-")}`, (request) =>
      manage(request, async (c) => {
        const body = parse(
          z.object({
            branchId: uuid.optional(),
            doctorId: uuid.nullable().default(null),
            windows: z.array(window).max(50),
          }),
          request.body,
        );
        const branchId = await defaultBranch(c, body.branchId);
        await c.query(`delete from ${table} where branch_id = $1 and doctor_id is not distinct from $2`, [
          branchId,
          body.doctorId,
        ]);
        for (const w of body.windows) {
          await c.query(
            `insert into ${table} (clinic_id, branch_id, doctor_id, weekday, start_time, end_time) values (app.current_clinic_id(), $1, $2, $3, $4, $5)`,
            [branchId, body.doctorId, w.weekday, w.start, w.end],
          );
        }
        return { ok: true };
      }),
    );
  }

  app.post("/v1/holidays", (request) =>
    manage(request, async (c) => {
      const b = parse(
        z.object({ date: localDate, name: z.string().trim().min(1).max(100), branchId: uuid.nullish() }),
        request.body,
      );
      const { rows } = await c.query(
        "insert into holidays (clinic_id, branch_id, date, name) values (app.current_clinic_id(), $1, $2, $3) returning id, date::text, name",
        [b.branchId ?? null, b.date, b.name],
      );
      return rows[0];
    }),
  );
  app.delete("/v1/holidays/:id", (request) =>
    manage(request, async (c) => {
      await c.query("delete from holidays where id = $1", [parse(idParams, request.params).id]);
      return { ok: true };
    }),
  );

  // Doctors' leave can be entered by anyone who manages the schedule.
  app.post("/v1/leaves", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c) => {
      const b = parse(
        z.object({
          doctorId: uuid,
          startsAt: instant,
          endsAt: instant,
          reason: z.string().max(200).nullish(),
        }),
        request.body,
      );
      if (b.endsAt <= b.startsAt) throw new HttpError(400, "invalid_input", "Leave must end after it starts");
      const { rows } = await c.query(
        "insert into leaves (clinic_id, doctor_id, starts_at, ends_at, reason) values (app.current_clinic_id(), $1, $2, $3, $4) returning *",
        [b.doctorId, b.startsAt, b.endsAt, b.reason ?? null],
      );
      return rows[0];
    }),
  );
  app.delete("/v1/leaves/:id", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c) => {
      await c.query("delete from leaves where id = $1", [parse(idParams, request.params).id]);
      return { ok: true };
    }),
  );

  app.post("/v1/emergency-slots", (request) =>
    manage(request, async (c) => {
      const b = parse(
        z.object({
          chairId: uuid,
          weekday: z.number().int().min(0).max(6),
          start: clockTime,
          durationMin: z.number().int().min(10).max(240),
        }),
        request.body,
      );
      const branch = await c.query("select branch_id from chairs where id = $1", [b.chairId]);
      if (!branch.rows[0]) throw new HttpError(404, "not_found", "Chair not found");
      const { rows } = await c.query(
        `insert into emergency_slots (clinic_id, branch_id, chair_id, weekday, start_time, duration_min)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5) returning *`,
        [branch.rows[0].branch_id, b.chairId, b.weekday, b.start, b.durationMin],
      );
      return rows[0];
    }),
  );
  app.delete("/v1/emergency-slots/:id", (request) =>
    manage(request, async (c) => {
      // Deactivating releases its future reserves (database trigger) and keeps the history.
      await c.query("update emergency_slots set active = false where id = $1", [
        parse(idParams, request.params).id,
      ]);
      return { ok: true };
    }),
  );
}

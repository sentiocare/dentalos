import type { PoolClient } from "pg";
import { DomainError, pgErrorCode, sequential } from "../errors";
import { addDays, localDateOf, localMinutesOf, zonedInstant, type LocalDate } from "../time";
import { checkPlacement, findAvailableSlots, pickOptions, type PlacementWarning } from "./availability";
import type { BusyInterval, PartOfDay, ProcedureSpec, ScheduleConfig, SlotCandidate } from "./types";

/**
 * Database-backed scheduling. Every function takes a client inside `withClinic`, so row-level security
 * scopes all reads and writes to one clinic. The database, not this code, guarantees no double booking;
 * this layer turns its refusals into clear errors.
 */

export interface ClinicSchedulingSettings {
  timezone: string;
  slotStepMin: number;
  holdMinutes: number;
  minLeadMin: number;
  bookingHorizonDays: number;
}

export async function loadClinicSettings(client: PoolClient): Promise<ClinicSchedulingSettings> {
  const { rows } = await client.query(
    `select timezone, slot_step_min, hold_minutes, min_booking_lead_min, booking_horizon_days
     from clinics where id = app.current_clinic_id()`,
  );
  const r = rows[0];
  if (!r) throw new DomainError("not_found", "Clinic not found");
  return {
    timezone: r.timezone,
    slotStepMin: r.slot_step_min,
    holdMinutes: r.hold_minutes,
    minLeadMin: r.min_booking_lead_min,
    bookingHorizonDays: r.booking_horizon_days,
  };
}

export async function defaultBranchId(client: PoolClient): Promise<string> {
  const { rows } = await client.query("select id from branches order by is_default desc, name limit 1");
  if (!rows[0]) throw new DomainError("invalid", "Clinic has no branch configured");
  return rows[0].id;
}

export async function loadScheduleConfig(client: PoolClient): Promise<ScheduleConfig> {
  const settings = await loadClinicSettings(client);
  const time = (t: string) => t.slice(0, 5);
  const q = (sql: string) => () => client.query(sql);
  const [doctors, chairs, hours, breaks, visiting, holidays, leaves] = await sequential(
    q("select id, name, kind, active from doctors order by created_at, name"),
    q("select id, branch_id, name, equipment, active, sort_order from chairs"),
    q("select branch_id, doctor_id, weekday, start_time, end_time from working_hours"),
    q("select branch_id, doctor_id, weekday, start_time, end_time from breaks"),
    q(
      "select branch_id, doctor_id, weekday, start_time, end_time, valid_from::text, valid_to::text from doctor_visiting_schedules",
    ),
    q("select branch_id, date::text, name from holidays"),
    q("select doctor_id, starts_at, ends_at from leaves where ends_at > now() - interval '1 day'"),
  );
  return {
    timezone: settings.timezone,
    slotStepMin: settings.slotStepMin,
    minLeadMin: settings.minLeadMin,
    doctors: doctors.rows.map((d) => ({ id: d.id, name: d.name, kind: d.kind, active: d.active })),
    chairs: chairs.rows.map((c) => ({
      id: c.id,
      branchId: c.branch_id,
      name: c.name,
      equipment: c.equipment,
      active: c.active,
      sortOrder: c.sort_order,
    })),
    workingHours: hours.rows.map((h) => ({
      branchId: h.branch_id,
      doctorId: h.doctor_id,
      weekday: h.weekday,
      start: time(h.start_time),
      end: time(h.end_time),
    })),
    breaks: breaks.rows.map((h) => ({
      branchId: h.branch_id,
      doctorId: h.doctor_id,
      weekday: h.weekday,
      start: time(h.start_time),
      end: time(h.end_time),
    })),
    visiting: visiting.rows.map((v) => ({
      branchId: v.branch_id,
      doctorId: v.doctor_id,
      weekday: v.weekday,
      start: time(v.start_time),
      end: time(v.end_time),
      validFrom: v.valid_from,
      validTo: v.valid_to,
    })),
    holidays: holidays.rows.map((h) => ({ branchId: h.branch_id, date: h.date, name: h.name })),
    leaves: leaves.rows.map((l) => ({ doctorId: l.doctor_id, startsAt: l.starts_at, endsAt: l.ends_at })),
  };
}

export async function loadProcedure(client: PoolClient, procedureId: string): Promise<ProcedureSpec> {
  const { rows } = await client.query(
    `select id, name, default_duration_min, buffer_after_min, required_equipment, allowed_doctor_ids
     from procedure_types where id = $1 and active`,
    [procedureId],
  );
  const p = rows[0];
  if (!p) throw new DomainError("not_found", "Procedure not found");
  return {
    id: p.id,
    name: p.name,
    durationMin: p.default_duration_min,
    bufferMin: p.buffer_after_min,
    requiredEquipment: p.required_equipment,
    allowedDoctorIds: p.allowed_doctor_ids,
  };
}

/** Everything that blocks doctors or chairs in the window: appointments, live holds, emergency reserves. */
export async function loadBusy(client: PoolClient, from: Date, to: Date): Promise<BusyInterval[]> {
  const { rows } = await client.query(
    `select resource_id, lower(occupied) as s, upper(occupied) as e
     from resource_occupancy
     where occupied && tstzrange($1, $2)
       and (source_kind <> 'hold' or expires_at > now())`,
    [from, to],
  );
  return rows.map((r) => ({ resourceId: r.resource_id, start: r.s, end: r.e }));
}

export interface SlotSearch {
  procedureId: string;
  branchId?: string;
  fromDate?: LocalDate;
  toDate?: LocalDate;
  doctorId?: string;
  partsOfDay?: PartOfDay[];
  /** Preferred clinic-local time of day ("shaam 5 baje" = 1020): the closest times are offered first. */
  nearMinutes?: number;
  now?: Date;
}

export async function findSlots(client: PoolClient, search: SlotSearch): Promise<SlotCandidate[]> {
  const now = search.now ?? new Date();
  const [config, procedure, branchId] = await sequential(
    () => loadScheduleConfig(client),
    () => loadProcedure(client, search.procedureId),
    async () => search.branchId ?? defaultBranchId(client),
  );
  const settings = await loadClinicSettings(client);
  const today = localDateOf(now, config.timezone);
  const fromDate = search.fromDate && search.fromDate > today ? search.fromDate : today;
  const lastAllowed = addDays(today, settings.bookingHorizonDays);
  const toDate = [search.toDate ?? addDays(fromDate, 13), lastAllowed].sort()[0]!;
  if (toDate < fromDate) return [];

  const busy = await loadBusy(
    client,
    zonedInstant(fromDate, 0, config.timezone),
    zonedInstant(addDays(toDate, 1), 12 * 60, config.timezone),
  );
  return findAvailableSlots(config, procedure, busy, {
    branchId,
    fromDate,
    toDate,
    doctorId: search.doctorId,
    partsOfDay: search.partsOfDay,
    now,
  });
}

export interface Hold extends SlotCandidate {
  holdId: string;
  expiresAt: Date;
  procedureId: string;
  branchId: string;
}

/** Runs `fn` inside a savepoint so one failed insert does not abort the surrounding transaction. */
async function trySavepoint<T>(client: PoolClient, fn: () => Promise<T>): Promise<T | undefined> {
  await client.query("savepoint attempt");
  try {
    const result = await fn();
    await client.query("release savepoint attempt");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint attempt");
    if (pgErrorCode(error) === "23P01") return undefined;
    throw error;
  }
}

/**
 * Finds slots and places short holds on up to `count` of them, so the options read to a caller cannot be
 * taken by someone else while they decide (Build Prompt §5.3, §8.1 find_slots).
 */
export async function offerSlots(
  client: PoolClient,
  search: SlotSearch & { count: number; holder: string },
): Promise<Hold[]> {
  const settings = await loadClinicSettings(client);
  const procedure = await loadProcedure(client, search.procedureId);
  const branchId = search.branchId ?? (await defaultBranchId(client));
  let candidates = await findSlots(client, { ...search, branchId });
  if (search.nearMinutes !== undefined) {
    // Earliest day first; within a day, closest to the time asked for.
    const near = search.nearMinutes;
    const distance = (c: (typeof candidates)[number]) =>
      Math.abs(localMinutesOf(c.start, settings.timezone) - near);
    candidates = [...candidates].sort((a, b) =>
      a.date === b.date ? distance(a) - distance(b) : a.date < b.date ? -1 : 1,
    );
  }
  const holds: Hold[] = [];

  while (holds.length < search.count && candidates.length > 0) {
    const options = pickOptions(candidates, search.count - holds.length, settings.timezone);
    for (const option of options) {
      const inserted = await trySavepoint(client, () =>
        client.query(
          `insert into slot_holds (clinic_id, branch_id, doctor_id, chair_id, procedure_type_id, starts_at, ends_at,
                                   buffer_min, expires_at, holder)
           values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8), $9)
           returning id, expires_at`,
          [
            branchId,
            option.doctorId,
            option.chairId,
            procedure.id,
            option.start,
            option.end,
            procedure.bufferMin,
            settings.holdMinutes,
            search.holder,
          ],
        ),
      );
      if (inserted) {
        const row = inserted.rows[0];
        holds.push({
          ...option,
          holdId: row.id,
          expiresAt: row.expires_at,
          procedureId: procedure.id,
          branchId,
        });
      }
    }
    // Remove what we tried (held or lost to a race) and anything now overlapping our holds.
    candidates = candidates.filter(
      (c) =>
        !options.includes(c) &&
        !holds.some(
          (h) =>
            h.start < c.occupiedUntil &&
            c.start < h.occupiedUntil &&
            (h.doctorId === c.doctorId || h.chairId === c.chairId),
        ),
    );
  }
  if (search.nearMinutes !== undefined) {
    // The time asked for comes first ("5 baje? I have 5 PM, or 3:30 PM").
    const near = search.nearMinutes;
    const distance = (h: Hold) => Math.abs(localMinutesOf(h.start, settings.timezone) - near);
    return holds.sort((a, b) =>
      a.date === b.date ? distance(a) - distance(b) : a.start.getTime() - b.start.getTime(),
    );
  }
  return holds.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export async function releaseHolds(client: PoolClient, holder: string): Promise<number> {
  const { rowCount } = await client.query("delete from slot_holds where holder = $1", [holder]);
  return rowCount ?? 0;
}

export interface AppointmentRow {
  id: string;
  branchId: string;
  patientId: string;
  doctorId: string;
  chairId: string;
  procedureTypeId: string | null;
  startsAt: Date;
  endsAt: Date;
  bufferMin: number;
  status: AppointmentStatus;
  source: string;
  notes: string | null;
  idempotencyKey: string | null;
  treatmentStepId: string | null;
}

export type AppointmentStatus =
  "booked" | "confirmed" | "checked_in" | "in_chair" | "completed" | "cancelled" | "no_show";

const APPOINTMENT_COLUMNS = `id, branch_id, patient_id, doctor_id, chair_id, procedure_type_id, starts_at, ends_at,
  buffer_min, status, source, notes, idempotency_key, treatment_step_id`;

function toAppointment(r: Record<string, unknown>): AppointmentRow {
  return {
    id: r.id as string,
    branchId: r.branch_id as string,
    patientId: r.patient_id as string,
    doctorId: r.doctor_id as string,
    chairId: r.chair_id as string,
    procedureTypeId: r.procedure_type_id as string | null,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    bufferMin: r.buffer_min as number,
    status: r.status as AppointmentStatus,
    source: r.source as string,
    notes: r.notes as string | null,
    idempotencyKey: r.idempotency_key as string | null,
    treatmentStepId: (r.treatment_step_id as string | null) ?? null,
  };
}

async function findByIdempotencyKey(client: PoolClient, key: string | undefined) {
  if (!key) return undefined;
  const { rows } = await client.query(
    `select ${APPOINTMENT_COLUMNS} from appointments where idempotency_key = $1`,
    [key],
  );
  return rows[0] ? toAppointment(rows[0]) : undefined;
}

async function assertPatient(client: PoolClient, patientId: string) {
  const { rows } = await client.query("select 1 from patients where id = $1 and deleted_at is null", [
    patientId,
  ]);
  if (!rows[0]) throw new DomainError("not_found", "Patient not found");
}

async function insertAppointment(
  client: PoolClient,
  a: {
    branchId: string;
    patientId: string;
    doctorId: string;
    chairId: string;
    procedureTypeId: string | null;
    startsAt: Date;
    endsAt: Date;
    bufferMin: number;
    source: string;
    notes?: string | null;
    bookedByUserId?: string | null;
    idempotencyKey?: string | null;
    treatmentStepId?: string | null;
  },
): Promise<AppointmentRow> {
  const inserted = await trySavepoint(client, () =>
    client.query(
      `insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, procedure_type_id, starts_at,
                                 ends_at, buffer_min, source, notes, booked_by_user_id, idempotency_key, treatment_step_id)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning ${APPOINTMENT_COLUMNS}`,
      [
        a.branchId,
        a.patientId,
        a.doctorId,
        a.chairId,
        a.procedureTypeId,
        a.startsAt,
        a.endsAt,
        a.bufferMin,
        a.source,
        a.notes ?? null,
        a.bookedByUserId ?? null,
        a.idempotencyKey ?? null,
        a.treatmentStepId ?? null,
      ],
    ),
  );
  if (!inserted) throw new DomainError("slot_taken", "That time is no longer free for this doctor or chair");
  return toAppointment(inserted.rows[0]);
}

/**
 * Books the slot a patient picked from offered holds. Returns only after the insert succeeded inside the
 * caller's transaction; callers must commit before telling the patient (Build Prompt §3.1).
 */
export async function bookFromHold(
  client: PoolClient,
  input: {
    holdId: string;
    patientId: string;
    source: "voice" | "whatsapp" | "staff";
    notes?: string;
    idempotencyKey?: string;
    bookedByUserId?: string;
    /** The treatment sitting this visit is for (the plan updates itself). */
    treatmentStepId?: string | null;
  },
): Promise<AppointmentRow> {
  const existing = await findByIdempotencyKey(client, input.idempotencyKey);
  if (existing) return existing;
  await assertPatient(client, input.patientId);

  const { rows } = await client.query(
    `delete from slot_holds where id = $1
     returning branch_id, doctor_id, chair_id, procedure_type_id, starts_at, ends_at, buffer_min, holder`,
    [input.holdId],
  );
  const hold = rows[0];
  if (!hold)
    throw new DomainError("hold_not_found", "The offered slot is no longer held; please offer slots again");

  // Even if the hold expired a moment ago, the slot may still be free: the insert decides.
  const appointment = await insertAppointment(client, {
    branchId: hold.branch_id,
    patientId: input.patientId,
    doctorId: hold.doctor_id,
    chairId: hold.chair_id,
    procedureTypeId: hold.procedure_type_id,
    startsAt: hold.starts_at,
    endsAt: hold.ends_at,
    bufferMin: hold.buffer_min,
    source: input.source,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
    bookedByUserId: input.bookedByUserId,
    treatmentStepId: input.treatmentStepId,
  });
  // The caller's other offered options are no longer needed.
  await releaseHolds(client, hold.holder);
  return appointment;
}

export interface StaffPlacement {
  branchId?: string;
  doctorId: string;
  chairId: string;
  startsAt: Date;
  /** Defaults to the procedure's duration. */
  endsAt?: Date;
  procedureTypeId?: string | null;
  /** Staff saw the warnings and want to book anyway. */
  acknowledgeWarnings?: boolean;
  /** Fill a reserved emergency slot (staff only). */
  useEmergencyReserve?: boolean;
}

async function resolvePlacement(client: PoolClient, p: StaffPlacement, now: Date) {
  const config = await loadScheduleConfig(client);
  const procedure = p.procedureTypeId ? await loadProcedure(client, p.procedureTypeId) : null;
  const branchId = p.branchId ?? (await defaultBranchId(client));
  const endsAt =
    p.endsAt ?? (procedure ? new Date(p.startsAt.getTime() + procedure.durationMin * 60_000) : undefined);
  if (!endsAt) throw new DomainError("invalid", "End time is required when no procedure is chosen");
  if (endsAt <= p.startsAt) throw new DomainError("invalid", "End time must be after start time");
  if (endsAt.getTime() - p.startsAt.getTime() > 8 * 60 * 60_000)
    throw new DomainError("invalid", "Appointment too long");

  const warnings: PlacementWarning[] = checkPlacement(
    config,
    { branchId, doctorId: p.doctorId, chairId: p.chairId, start: p.startsAt, end: endsAt },
    procedure,
    now,
  );
  if (warnings.length > 0 && !p.acknowledgeWarnings) {
    throw new DomainError("needs_confirmation", "Please confirm booking outside the normal schedule", {
      warnings,
    });
  }
  const bufferMin = procedure?.bufferMin ?? 0;
  if (p.useEmergencyReserve) {
    await client.query("select app.release_emergency_reserve($1, tstzrange($2, $3))", [
      p.chairId,
      p.startsAt,
      new Date(endsAt.getTime() + bufferMin * 60_000),
    ]);
  }
  return { branchId, endsAt, bufferMin, warnings, procedure };
}

export async function bookDirect(
  client: PoolClient,
  input: StaffPlacement & {
    patientId: string;
    source?: "staff" | "walk_in" | "import";
    notes?: string;
    idempotencyKey?: string;
    bookedByUserId?: string;
    treatmentStepId?: string | null;
    now?: Date;
  },
): Promise<{ appointment: AppointmentRow; warnings: PlacementWarning[] }> {
  const existing = await findByIdempotencyKey(client, input.idempotencyKey);
  if (existing) return { appointment: existing, warnings: [] };
  await assertPatient(client, input.patientId);
  const placed = await resolvePlacement(client, input, input.now ?? new Date());
  const appointment = await insertAppointment(client, {
    branchId: placed.branchId,
    patientId: input.patientId,
    doctorId: input.doctorId,
    chairId: input.chairId,
    procedureTypeId: input.procedureTypeId ?? null,
    startsAt: input.startsAt,
    endsAt: placed.endsAt,
    bufferMin: placed.bufferMin,
    source: input.source ?? "staff",
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
    bookedByUserId: input.bookedByUserId,
    treatmentStepId: input.treatmentStepId,
  });
  return { appointment, warnings: placed.warnings };
}

async function getAppointment(client: PoolClient, id: string, lock = false): Promise<AppointmentRow> {
  const { rows } = await client.query(
    `select ${APPOINTMENT_COLUMNS} from appointments where id = $1 ${lock ? "for update" : ""}`,
    [id],
  );
  if (!rows[0]) throw new DomainError("not_found", "Appointment not found");
  return toAppointment(rows[0]);
}

const ACTIVE: AppointmentStatus[] = ["booked", "confirmed", "checked_in", "in_chair"];

/** Move and/or resize (drag and drop on the calendar). Keeps the duration if no new end is given. */
export async function moveAppointment(
  client: PoolClient,
  id: string,
  change: Partial<Omit<StaffPlacement, "procedureTypeId" | "branchId">> & { now?: Date },
): Promise<{ appointment: AppointmentRow; warnings: PlacementWarning[] }> {
  const current = await getAppointment(client, id, true);
  if (!ACTIVE.includes(current.status))
    throw new DomainError("invalid", `Cannot move a ${current.status} appointment`);
  const startsAt = change.startsAt ?? current.startsAt;
  const endsAt =
    change.endsAt ?? new Date(startsAt.getTime() + (current.endsAt.getTime() - current.startsAt.getTime()));
  const placed = await resolvePlacement(
    client,
    {
      branchId: current.branchId,
      doctorId: change.doctorId ?? current.doctorId,
      chairId: change.chairId ?? current.chairId,
      startsAt,
      endsAt,
      procedureTypeId: current.procedureTypeId,
      acknowledgeWarnings: change.acknowledgeWarnings,
      useEmergencyReserve: change.useEmergencyReserve,
    },
    change.now ?? new Date(),
  );
  const updated = await trySavepoint(client, () =>
    client.query(
      `update appointments set starts_at = $2, ends_at = $3, doctor_id = $4, chair_id = $5
       where id = $1 returning ${APPOINTMENT_COLUMNS}`,
      [id, startsAt, endsAt, change.doctorId ?? current.doctorId, change.chairId ?? current.chairId],
    ),
  );
  if (!updated) throw new DomainError("slot_taken", "That time is no longer free for this doctor or chair");
  return { appointment: toAppointment(updated.rows[0]), warnings: placed.warnings };
}

export async function cancelAppointment(
  client: PoolClient,
  id: string,
  reason?: string,
): Promise<AppointmentRow> {
  const current = await getAppointment(client, id, true);
  if (current.status === "cancelled") return current;
  if (!ACTIVE.includes(current.status))
    throw new DomainError("invalid", `Cannot cancel a ${current.status} appointment`);
  const { rows } = await client.query(
    `update appointments set status = 'cancelled', cancel_reason = $2 where id = $1 returning ${APPOINTMENT_COLUMNS}`,
    [id, reason ?? null],
  );
  return toAppointment(rows[0]);
}

const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ["confirmed", "checked_in", "in_chair", "completed", "cancelled", "no_show"],
  confirmed: ["booked", "checked_in", "in_chair", "completed", "cancelled", "no_show"],
  checked_in: ["in_chair", "completed", "no_show", "confirmed"],
  in_chair: ["completed", "checked_in"],
  completed: ["in_chair"],
  cancelled: ["booked"],
  no_show: ["booked", "checked_in"],
};

export async function setAppointmentStatus(
  client: PoolClient,
  id: string,
  status: AppointmentStatus,
): Promise<AppointmentRow> {
  const current = await getAppointment(client, id, true);
  if (current.status === status) return current;
  if (!TRANSITIONS[current.status].includes(status)) {
    throw new DomainError("invalid", `Cannot change a ${current.status} appointment to ${status}`);
  }
  // A visit finished early ends when it actually ended, so the doctor and chair are free for the next
  // patient (a walk-in can go in straight away) instead of staying blocked until the booked end.
  const updated = await trySavepoint(client, () =>
    client.query(
      `update appointments set status = $2,
         ends_at = case when $2 = 'completed' and now() > starts_at and now() < ends_at
                        then greatest(date_trunc('minute', now()), starts_at + interval '1 minute') else ends_at end
       where id = $1 returning ${APPOINTMENT_COLUMNS}`,
      [id, status],
    ),
  );
  // Reinstating a cancelled or no-show appointment needs its slot back.
  if (!updated) throw new DomainError("slot_taken", "That time has been given to someone else");
  if (status === "completed") {
    await client.query(
      "update patients set last_visit_at = greatest(coalesce(last_visit_at, $2), $2) where id = $1",
      [current.patientId, current.startsAt],
    );
  }
  return toAppointment(updated.rows[0]);
}

/**
 * Keeps emergency reserves materialised for the coming days. Runs in the worker with the privileged role
 * across all clinics (the function is not callable by app_user). Idempotent.
 */
export async function materializeEmergencyReserves(
  client: PoolClient,
  days = 14,
  now = new Date(),
): Promise<number> {
  const { rows } = await client.query(
    `select s.id, s.clinic_id, s.chair_id, s.weekday, s.start_time, s.duration_min, c.timezone
     from emergency_slots s join clinics c on c.id = s.clinic_id where s.active`,
  );
  let created = 0;
  for (const s of rows) {
    const today = localDateOf(now, s.timezone);
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== s.weekday) continue;
      const [h, m] = String(s.start_time).split(":").map(Number) as [number, number];
      const start = zonedInstant(date, h * 60 + m, s.timezone);
      if (start <= now) continue;
      const end = new Date(start.getTime() + s.duration_min * 60_000);
      const { rows: r } = await client.query(
        "select app.materialize_emergency_reserve($1, $2, $3, tstzrange($4, $5)) as ok",
        [s.clinic_id, s.id, s.chair_id, start, end],
      );
      if (r[0].ok) created++;
    }
  }
  return created;
}

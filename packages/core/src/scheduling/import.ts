import { createHash } from "node:crypto";
import { normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { DomainError } from "../errors";
import { isLikelySamePerson, nameSimilarity, normalizeName } from "../patients/names";
import { createPatient, findPatientsByPhone } from "../patients/service";
import { parseIndianDate } from "../patients/import";
import { addDays, isLocalDate, zonedInstant, type LocalDate } from "../time";
import { bookDirect, defaultBranchId, loadClinicSettings, setAppointmentStatus } from "./service";

/** Importing existing appointments from a register or another system's export (Build Prompt §5.3). */

export type AppointmentField =
  | "date"
  | "time"
  | "endTime"
  | "duration"
  | "patientName"
  | "phone"
  | "doctor"
  | "procedure"
  | "chair"
  | "notes";

const SYNONYMS: Record<AppointmentField, string[]> = {
  date: ["date", "appointment date", "appt date", "day", "tarikh", "तारीख"],
  time: ["time", "start", "start time", "appointment time", "slot", "samay", "समय"],
  endTime: ["end", "end time", "till"],
  duration: ["duration", "mins", "minutes", "duration (min)", "duration min"],
  patientName: ["patient", "patient name", "name", "naam", "नाम"],
  phone: ["phone", "mobile", "mobile no", "contact", "contact number", "phone number"],
  doctor: ["doctor", "dr", "doctor name", "consultant", "dentist"],
  procedure: ["procedure", "treatment", "reason", "service", "type", "work"],
  chair: ["chair", "operatory", "room"],
  notes: ["notes", "remarks", "comments"],
};

export function guessAppointmentMapping(headers: string[]): Partial<Record<AppointmentField, string>> {
  const clean = (h: string) =>
    h
      .toLowerCase()
      .replace(/[._\-:#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const mapping: Partial<Record<AppointmentField, string>> = {};
  const used = new Set<string>();
  for (const [field, synonyms] of Object.entries(SYNONYMS) as [AppointmentField, string[]][]) {
    const match = headers.find((h) => !used.has(h) && synonyms.includes(clean(h)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }
  return mapping;
}

/** "5 pm", "5:30 PM", "17:30", "17.30", "1730" → minutes since midnight. */
export function parseClockTime(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
  } else if (!m[2] && h <= 12 && h >= 1) {
    // "5" with no am/pm: clinics are open in the day, so 1–8 means afternoon/evening.
    if (h <= 8) h += 12;
  }
  if (h > 23) return null;
  return h * 60 + min;
}

export type AppointmentRowIssue =
  | "invalid_date"
  | "invalid_time"
  | "missing_patient"
  | "unknown_doctor"
  | "unknown_procedure"
  | "unknown_chair"
  | "invalid_phone";

export interface AppointmentPreviewRow {
  row: number;
  issues: AppointmentRowIssue[];
  /** Rows with blocking issues are not imported. */
  importable: boolean;
  value?: {
    date: LocalDate;
    startMin: number;
    endMin: number;
    patientName: string;
    phone: string | null;
    existingPatientId: string | null;
    doctorId: string;
    procedureTypeId: string | null;
    chairId: string | null;
    notes: string | null;
  };
}

interface Lookup {
  id: string;
  names: string[];
}

function bestMatch(input: string, options: Lookup[]): string | null {
  const wanted = normalizeName(input.replace(/^dr\.?\s*/i, ""));
  if (!wanted) return null;
  let best: { id: string; score: number } | null = null;
  for (const o of options) {
    for (const name of o.names) {
      const n = normalizeName(name.replace(/^dr\.?\s*/i, ""));
      const score =
        n === wanted ? 1 : n.startsWith(wanted) || wanted.startsWith(n) ? 0.9 : nameSimilarity(n, wanted);
      if (!best || score > best.score) best = { id: o.id, score };
    }
  }
  return best && best.score >= 0.5 ? best.id : null;
}

export async function previewAppointmentImport(
  client: PoolClient,
  rows: Record<string, string | undefined>[],
  mapping: Partial<Record<AppointmentField, string>>,
  today: LocalDate,
): Promise<AppointmentPreviewRow[]> {
  const [doctors, procedures, chairs] = await Promise.all([
    client.query("select id, name from doctors where active"),
    client.query(
      "select id, name, name_hi, code, synonyms, default_duration_min from procedure_types where active",
    ),
    client.query("select id, name from chairs where active"),
  ]);
  const doctorLookup = doctors.rows.map((d) => ({ id: d.id, names: [d.name] }));
  const procedureLookup = procedures.rows.map((p) => ({
    id: p.id,
    names: [p.name, p.name_hi, p.code.replace(/_/g, " "), ...p.synonyms].filter(Boolean),
  }));
  const durations = new Map(procedures.rows.map((p) => [p.id, p.default_duration_min as number]));
  const chairLookup = chairs.rows.map((c) => ({ id: c.id, names: [c.name] }));
  const onlyDoctor = doctors.rows.length === 1 ? (doctors.rows[0].id as string) : null;

  const result: AppointmentPreviewRow[] = [];
  for (const [index, raw] of rows.entries()) {
    const get = (f: AppointmentField) => {
      const v = mapping[f] ? raw[mapping[f]!] : undefined;
      return v?.trim() ? v.trim() : null;
    };
    const issues: AppointmentRowIssue[] = [];
    const dateRaw = get("date");
    // Future appointments are allowed, so parse against a far "today".
    const date = dateRaw
      ? isLocalDate(dateRaw)
        ? dateRaw
        : parseIndianDate(dateRaw, addDays(today, 3650))
      : null;
    if (!date) issues.push("invalid_date");
    const startMin = get("time") ? parseClockTime(get("time")!) : null;
    if (startMin === null) issues.push("invalid_time");

    const patientName = get("patientName");
    if (!patientName) issues.push("missing_patient");
    const phoneRaw = get("phone");
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) issues.push("invalid_phone");

    const doctorId = get("doctor") ? bestMatch(get("doctor")!, doctorLookup) : onlyDoctor;
    if (!doctorId) issues.push("unknown_doctor");
    const procedureTypeId = get("procedure") ? bestMatch(get("procedure")!, procedureLookup) : null;
    if (get("procedure") && !procedureTypeId) issues.push("unknown_procedure");
    const chairId = get("chair") ? bestMatch(get("chair")!, chairLookup) : null;
    if (get("chair") && !chairId) issues.push("unknown_chair");

    let endMin: number | null = null;
    if (startMin !== null) {
      const endRaw = get("endTime");
      const durationRaw = get("duration");
      if (endRaw) endMin = parseClockTime(endRaw);
      else if (durationRaw && Number(durationRaw) > 0) endMin = startMin + Math.round(Number(durationRaw));
      else endMin = startMin + (procedureTypeId ? (durations.get(procedureTypeId) ?? 30) : 30);
      if (endMin === null || endMin <= startMin) {
        issues.push("invalid_time");
        endMin = null;
      }
    }

    let existingPatientId: string | null = null;
    if (patientName && phone) {
      const matches = await findPatientsByPhone(client, phone);
      existingPatientId = matches.find((p) => isLikelySamePerson(p.name, patientName))?.id ?? null;
    }

    // Unknown procedure or chair are not blocking: the appointment is imported without them / in any chair.
    const blocking = issues.filter((i) => i !== "unknown_procedure" && i !== "unknown_chair");
    const importable = blocking.length === 0;
    result.push({
      row: index + 1,
      issues,
      importable,
      value:
        importable && date && startMin !== null && endMin !== null && patientName && doctorId
          ? {
              date,
              startMin,
              endMin,
              patientName,
              phone,
              existingPatientId,
              doctorId,
              procedureTypeId,
              chairId,
              notes: get("notes"),
            }
          : undefined,
    });
  }
  return result;
}

export interface AppointmentImportResult {
  row: number;
  status: "booked" | "already_imported" | "conflict" | "error";
  appointmentId?: string;
  message?: string;
}

/**
 * Books each importable row. Past appointments are stored as completed history. Each row gets a stable
 * idempotency key, so re-running the same file never duplicates. A row that clashes with another booking
 * is reported, not forced in.
 */
export async function commitAppointmentImport(
  client: PoolClient,
  rows: AppointmentPreviewRow[],
  now: Date = new Date(),
): Promise<AppointmentImportResult[]> {
  const settings = await loadClinicSettings(client);
  const branchId = await defaultBranchId(client);
  const { rows: chairs } = await client.query(
    "select id from chairs where active and branch_id = $1 order by sort_order, name",
    [branchId],
  );
  const createdPatients = new Map<string, string>();
  const results: AppointmentImportResult[] = [];

  for (const r of rows) {
    const v = r.value;
    if (!r.importable || !v) {
      results.push({ row: r.row, status: "error", message: r.issues.join(", ") });
      continue;
    }
    const key = `import:${createHash("sha256")
      .update([v.date, v.startMin, v.patientName.toLowerCase(), v.phone ?? "", v.doctorId].join("|"))
      .digest("hex")
      .slice(0, 32)}`;
    const existing = await client.query("select id from appointments where idempotency_key = $1", [key]);
    if (existing.rows[0]) {
      results.push({ row: r.row, status: "already_imported", appointmentId: existing.rows[0].id });
      continue;
    }

    const patientKey = `${v.phone ?? ""}|${normalizeName(v.patientName)}`;
    let patientId = v.existingPatientId ?? createdPatients.get(patientKey);
    if (!patientId) {
      patientId = (await createPatient(client, { name: v.patientName, phone: v.phone, source: "import" })).id;
      createdPatients.set(patientKey, patientId);
    }

    const startsAt = zonedInstant(v.date, v.startMin, settings.timezone);
    const endsAt = zonedInstant(v.date, v.endMin, settings.timezone);
    const chairOptions = v.chairId ? [v.chairId] : chairs.map((c) => c.id as string);
    let booked: string | undefined;
    let lastError: unknown;
    for (const chairId of chairOptions) {
      try {
        const { appointment } = await bookDirect(client, {
          branchId,
          patientId,
          doctorId: v.doctorId,
          chairId,
          procedureTypeId: v.procedureTypeId,
          startsAt,
          endsAt,
          acknowledgeWarnings: true,
          source: "import",
          notes: v.notes ?? undefined,
          idempotencyKey: key,
          now,
        });
        booked = appointment.id;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof DomainError && error.code === "slot_taken")) break;
      }
    }
    if (!booked) {
      const clash = lastError instanceof DomainError && lastError.code === "slot_taken";
      results.push({
        row: r.row,
        status: clash ? "conflict" : "error",
        message: clash ? "Clashes with another appointment" : (lastError as Error)?.message,
      });
      continue;
    }
    if (endsAt < now) await setAppointmentStatus(client, booked, "completed");
    results.push({ row: r.row, status: "booked", appointmentId: booked });
  }
  return results;
}

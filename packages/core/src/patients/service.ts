import { normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { DomainError, pgErrorCode } from "../errors.js";
import type { LocalDate } from "../time.js";
import {
  buildPatientImportPreview,
  type ImportedPatient,
  type PatientField,
  type PreviewRow,
} from "./import.js";

export interface PatientInput {
  name: string;
  phone?: string | null;
  altPhone?: string | null;
  dob?: LocalDate | null;
  approxBirthYear?: number | null;
  gender?: "female" | "male" | "other" | "unknown";
  languagePref?: string | null;
  source?: string | null;
  referredByPatientId?: string | null;
  address?: string | null;
  city?: string | null;
  notes?: string | null;
  fileNumber?: string | null;
}

export interface Patient extends Required<Omit<PatientInput, "gender">> {
  id: string;
  gender: "female" | "male" | "other" | "unknown";
  lastVisitAt: Date | null;
  createdAt: Date;
}

const COLUMNS = `id, name, phone, alt_phone, dob::text as dob, approx_birth_year, gender, language_pref, source,
  referred_by_patient_id, address, city, notes, file_number, last_visit_at, created_at`;

function toPatient(r: Record<string, unknown>): Patient {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string | null,
    altPhone: r.alt_phone as string | null,
    dob: r.dob as string | null,
    approxBirthYear: r.approx_birth_year as number | null,
    gender: r.gender as Patient["gender"],
    languagePref: r.language_pref as string | null,
    source: r.source as string | null,
    referredByPatientId: r.referred_by_patient_id as string | null,
    address: r.address as string | null,
    city: r.city as string | null,
    notes: r.notes as string | null,
    fileNumber: r.file_number as string | null,
    lastVisitAt: r.last_visit_at as Date | null,
    createdAt: r.created_at as Date,
  };
}

function phoneOrThrow(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const phone = normalizePhone(value);
  if (!phone) throw new DomainError("invalid", `Invalid phone number in ${field}`, { field });
  return phone;
}

/**
 * Search by phone (any 4+ digits, matched against the end of the number), file number, or name
 * (tolerant of spelling). Target: under one second for tens of thousands of patients.
 */
export async function searchPatients(client: PoolClient, query: string, limit = 20): Promise<Patient[]> {
  const q = query.trim();
  if (!q) {
    const { rows } = await client.query(
      `select ${COLUMNS} from patients where deleted_at is null order by coalesce(last_visit_at, created_at) desc limit $1`,
      [limit],
    );
    return rows.map(toPatient);
  }
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 4 && digits.length >= q.replace(/\s/g, "").length - 3) {
    const tail = digits.length > 10 ? digits.slice(-10) : digits;
    const { rows } = await client.query(
      `select ${COLUMNS} from patients
       where deleted_at is null and (phone like '%' || $1 or alt_phone like '%' || $1 or file_number = $2)
       order by coalesce(last_visit_at, created_at) desc limit $3`,
      [tail, q, limit],
    );
    return rows.map(toPatient);
  }
  const { rows } = await client.query(
    `select ${COLUMNS} from patients
     where deleted_at is null
       and (lower(name) like '%' || lower($1) || '%' or lower(name) % lower($1) or file_number = $1)
     order by (lower(name) like lower($1) || '%') desc, similarity(lower(name), lower($1)) desc, name
     limit $2`,
    [q, limit],
  );
  return rows.map(toPatient);
}

export async function getPatient(client: PoolClient, id: string): Promise<Patient> {
  const { rows } = await client.query(
    `select ${COLUMNS} from patients where id = $1 and deleted_at is null`,
    [id],
  );
  if (!rows[0]) throw new DomainError("not_found", "Patient not found");
  return toPatient(rows[0]);
}

export async function findPatientsByPhone(client: PoolClient, phone: string): Promise<Patient[]> {
  const { rows } = await client.query(
    `select ${COLUMNS} from patients where deleted_at is null and (phone = $1 or alt_phone = $1) order by created_at`,
    [phone],
  );
  return rows.map(toPatient);
}

export async function createPatient(client: PoolClient, input: PatientInput): Promise<Patient> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new DomainError("invalid", "Name is required", { field: "name" });
  const { rows } = await client.query(
    `insert into patients (clinic_id, name, phone, alt_phone, dob, approx_birth_year, gender, language_pref, source,
                           referred_by_patient_id, address, city, notes, file_number)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning ${COLUMNS}`,
    [
      name,
      phoneOrThrow(input.phone, "phone"),
      phoneOrThrow(input.altPhone, "altPhone"),
      input.dob ?? null,
      input.approxBirthYear ?? null,
      input.gender ?? "unknown",
      input.languagePref ?? null,
      input.source ?? null,
      input.referredByPatientId ?? null,
      input.address ?? null,
      input.city ?? null,
      input.notes ?? null,
      input.fileNumber ?? null,
    ],
  );
  return toPatient(rows[0]);
}

const UPDATABLE: Record<keyof PatientInput, string> = {
  name: "name",
  phone: "phone",
  altPhone: "alt_phone",
  dob: "dob",
  approxBirthYear: "approx_birth_year",
  gender: "gender",
  languagePref: "language_pref",
  source: "source",
  referredByPatientId: "referred_by_patient_id",
  address: "address",
  city: "city",
  notes: "notes",
  fileNumber: "file_number",
};

export async function updatePatient(
  client: PoolClient,
  id: string,
  change: Partial<PatientInput>,
): Promise<Patient> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, column] of Object.entries(UPDATABLE) as [keyof PatientInput, string][]) {
    if (!(key in change)) continue;
    let value = change[key] ?? null;
    if (key === "phone" || key === "altPhone") value = phoneOrThrow(value as string | null, key);
    if (key === "name") {
      value = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!value) throw new DomainError("invalid", "Name is required", { field: "name" });
    }
    if (key === "referredByPatientId" && value === id)
      throw new DomainError("invalid", "A patient cannot refer themselves");
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return getPatient(client, id);
  const { rows } = await client.query(
    `update patients set ${sets.join(", ")} where id = $1 and deleted_at is null returning ${COLUMNS}`,
    values,
  );
  if (!rows[0]) throw new DomainError("not_found", "Patient not found");
  return toPatient(rows[0]);
}

export async function deletePatient(client: PoolClient, id: string): Promise<void> {
  const { rowCount } = await client.query(
    "update patients set deleted_at = now() where id = $1 and deleted_at is null",
    [id],
  );
  if (!rowCount) throw new DomainError("not_found", "Patient not found");
}

export interface FamilyMember {
  linkId: string;
  patientId: string;
  name: string;
  phone: string | null;
  /** How the family member is related to the patient being viewed. */
  relationship: string;
  direction: "outgoing" | "incoming";
}

export async function listFamily(client: PoolClient, patientId: string): Promise<FamilyMember[]> {
  const { rows } = await client.query(
    `select l.id as link_id, p.id, p.name, p.phone, l.relationship, 'outgoing' as direction
       from patient_family_links l join patients p on p.id = l.related_patient_id
      where l.patient_id = $1 and p.deleted_at is null
     union all
     select l.id, p.id, p.name, p.phone, l.relationship, 'incoming'
       from patient_family_links l join patients p on p.id = l.patient_id
      where l.related_patient_id = $1 and p.deleted_at is null`,
    [patientId],
  );
  return rows.map((r) => ({
    linkId: r.link_id,
    patientId: r.id,
    name: r.name,
    phone: r.phone,
    relationship: r.relationship,
    direction: r.direction,
  }));
}

/** Links a family member, e.g. a caller booking for their mother (Build Prompt §5.1). */
export async function linkFamily(
  client: PoolClient,
  input: { patientId: string; relatedPatientId: string; relationship: string; isPrimaryContact?: boolean },
): Promise<string> {
  if (input.patientId === input.relatedPatientId)
    throw new DomainError("invalid", "Cannot link a patient to themselves");
  try {
    const { rows } = await client.query(
      `insert into patient_family_links (clinic_id, patient_id, related_patient_id, relationship, is_primary_contact)
       values (app.current_clinic_id(), $1, $2, $3, $4)
       on conflict (patient_id, related_patient_id) do update set relationship = excluded.relationship
       returning id`,
      [
        input.patientId,
        input.relatedPatientId,
        input.relationship.trim().toLowerCase(),
        input.isPrimaryContact ?? false,
      ],
    );
    return rows[0].id;
  } catch (error) {
    if (pgErrorCode(error) === "23503") throw new DomainError("not_found", "Patient not found");
    throw error;
  }
}

export async function unlinkFamily(client: PoolClient, linkId: string): Promise<void> {
  await client.query("delete from patient_family_links where id = $1", [linkId]);
}

export async function previewPatientImport(
  client: PoolClient,
  rows: Record<string, string | undefined>[],
  mapping: Partial<Record<PatientField, string>>,
  today: LocalDate,
): Promise<PreviewRow[]> {
  const phones = new Set<string>();
  for (const raw of rows) {
    for (const field of ["phone", "altPhone"] as const) {
      const header = mapping[field];
      const cell = header ? raw[header] : undefined;
      for (const part of cell?.split(/[,/;|]|\s{2,}/) ?? []) {
        const p = normalizePhone(part.trim());
        if (p) phones.add(p);
      }
    }
  }
  const { rows: existing } = await client.query(
    `select id, name, phone, alt_phone from patients
     where deleted_at is null and (phone = any($1) or alt_phone = any($1))`,
    [[...phones]],
  );
  return buildPatientImportPreview(
    rows,
    mapping,
    existing.map((e) => ({ id: e.id, name: e.name, phone: e.phone, altPhone: e.alt_phone })),
    today,
  );
}

export interface ImportDecision {
  action: "create" | "merge" | "skip";
  value: ImportedPatient | null;
  mergeIntoId?: string;
}

/**
 * Saves the rows staff approved. "merge" only fills fields the existing record is missing; it never
 * overwrites what the clinic already has. Runs in the caller's transaction: all rows or none.
 */
export async function commitPatientImport(
  client: PoolClient,
  decisions: ImportDecision[],
): Promise<{ created: number; merged: number; skipped: number }> {
  const creates = decisions.filter((d) => d.action === "create" && d.value).map((d) => d.value!);
  const merges = decisions.filter((d) => d.action === "merge" && d.value && d.mergeIntoId);
  const chunk = 500;
  for (let i = 0; i < creates.length; i += chunk) {
    const part = creates.slice(i, i + chunk);
    await client.query(
      `insert into patients (clinic_id, name, phone, alt_phone, dob, approx_birth_year, gender, address, city, notes,
                             file_number, source)
       select app.current_clinic_id(), * from unnest(
         $1::text[], $2::text[], $3::text[], $4::date[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[],
         $10::text[], $11::text[])`,
      [
        part.map((p) => p.name),
        part.map((p) => p.phone),
        part.map((p) => p.altPhone),
        part.map((p) => p.dob),
        part.map((p) => p.approxBirthYear),
        part.map((p) => p.gender),
        part.map((p) => p.address),
        part.map((p) => p.city),
        part.map((p) => p.notes),
        part.map((p) => p.fileNumber),
        part.map((p) => p.source ?? "import"),
      ],
    );
  }
  for (const m of merges) {
    const v = m.value!;
    await client.query(
      `update patients set
         alt_phone = coalesce(alt_phone, case when phone is distinct from $2 then $2 end, $3),
         dob = coalesce(dob, $4), approx_birth_year = coalesce(approx_birth_year, $5),
         gender = case when gender = 'unknown' then $6 else gender end,
         address = coalesce(address, $7), city = coalesce(city, $8),
         notes = case when $9::text is null then notes when notes is null then $9 else notes || E'\\n' || $9 end,
         file_number = coalesce(file_number, $10)
       where id = $1 and deleted_at is null`,
      [
        m.mergeIntoId,
        v.phone,
        v.altPhone,
        v.dob,
        v.approxBirthYear,
        v.gender,
        v.address,
        v.city,
        v.notes,
        v.fileNumber,
      ],
    );
  }
  return {
    created: creates.length,
    merged: merges.length,
    skipped: decisions.length - creates.length - merges.length,
  };
}

import type { StorageProvider } from "@dentalos/adapters";
import type { PoolClient } from "pg";
import { financialYear } from "../billing/ledger";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { a4, letterhead } from "../pdf";
import { localDateOf } from "../time";

/**
 * The doctor's record of a visit (reception and surgery in one system): case notes, the tooth chart and
 * prescriptions. Only staff write these; the assistant never reads or writes them. Prescriptions are
 * written from the doctor's own templates or by hand, are never changed once written (a mistake is
 * cancelled and written again), and print with what Indian rules require: the doctor's name,
 * qualification and registration number, the patient's name, age and sex, and medicines by name with
 * dose, frequency and duration.
 */

// ------------------------------------------------------------------------------------------ notes

export interface NoteInput {
  patientId: string;
  appointmentId?: string | null;
  doctorId?: string | null;
  complaint?: string | null;
  findings?: string | null;
  diagnosis?: string | null;
  treatment?: string | null;
  advice?: string | null;
  userId?: string | null;
}

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim().slice(0, 4000) : null);

/** Saves the note for a visit (one per visit, so saving again updates it) or a note without a visit. */
export async function saveNote(client: PoolClient, input: NoteInput) {
  const fields = [input.complaint, input.findings, input.diagnosis, input.treatment, input.advice].map(clean);
  if (fields.every((f) => f === null)) throw new DomainError("invalid", "Write something in the note");
  const values = [
    input.patientId,
    input.appointmentId ?? null,
    input.doctorId ?? null,
    ...fields,
    input.userId ?? null,
  ];
  const { rows } = input.appointmentId
    ? await client.query(
        `insert into clinical_notes (clinic_id, patient_id, appointment_id, doctor_id, complaint, findings, diagnosis, treatment, advice, created_by)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (clinic_id, appointment_id) do update set
           doctor_id = coalesce(excluded.doctor_id, clinical_notes.doctor_id), complaint = excluded.complaint,
           findings = excluded.findings, diagnosis = excluded.diagnosis, treatment = excluded.treatment,
           advice = excluded.advice
         where clinical_notes.patient_id = excluded.patient_id
         returning id`,
        values,
      )
    : await client.query(
        `insert into clinical_notes (clinic_id, patient_id, appointment_id, doctor_id, complaint, findings, diagnosis, treatment, advice, created_by)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        values,
      );
  if (!rows[0]) throw new DomainError("invalid", "That visit belongs to another patient");
  return { id: rows[0].id as string };
}

export async function listNotes(client: PoolClient, patientId: string) {
  const { rows } = await client.query(
    `select n.id, n.appointment_id, n.complaint, n.findings, n.diagnosis, n.treatment, n.advice, n.created_at,
            n.updated_at, d.name as doctor_name, a.starts_at as visit_at, pt.name as procedure_name
     from clinical_notes n left join doctors d on d.id = n.doctor_id
     left join appointments a on a.id = n.appointment_id left join procedure_types pt on pt.id = a.procedure_type_id
     where n.patient_id = $1 order by coalesce(a.starts_at, n.created_at) desc limit 100`,
    [patientId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    appointmentId: r.appointment_id as string | null,
    complaint: r.complaint as string | null,
    findings: r.findings as string | null,
    diagnosis: r.diagnosis as string | null,
    treatment: r.treatment as string | null,
    advice: r.advice as string | null,
    doctorName: r.doctor_name as string | null,
    visitAt: (r.visit_at ?? r.created_at) as Date,
    procedureName: r.procedure_name as string | null,
    edited: (r.updated_at as Date).getTime() - (r.created_at as Date).getTime() > 1000,
  }));
}

// ------------------------------------------------------------------------------------------ tooth chart

export const TOOTH_CONDITIONS = [
  "healthy",
  "caries",
  "filled",
  "rct",
  "crown",
  "missing",
  "implant",
  "bridge",
  "mobile",
  "fractured",
  "impacted",
  "to_extract",
  "other",
] as const;
export type ToothCondition = (typeof TOOTH_CONDITIONS)[number];

export function isTooth(n: number): boolean {
  const q = Math.floor(n / 10);
  const i = n % 10;
  return (q >= 1 && q <= 4 && i >= 1 && i <= 8) || (q >= 5 && q <= 8 && i >= 1 && i <= 5);
}

export async function recordTooth(
  client: PoolClient,
  input: {
    patientId: string;
    tooth: number;
    condition: ToothCondition;
    surfaces?: string | null;
    note?: string | null;
    appointmentId?: string | null;
    userId?: string | null;
  },
) {
  if (!isTooth(input.tooth)) throw new DomainError("invalid", `${input.tooth} is not a tooth number (FDI)`);
  const surfaces = input.surfaces?.toUpperCase().replace(/[^MODBLIF]/g, "") || null;
  const { rows } = await client.query(
    `insert into tooth_findings (clinic_id, patient_id, tooth, condition, surfaces, note, appointment_id, recorded_by)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.patientId,
      input.tooth,
      input.condition,
      surfaces,
      clean(input.note),
      input.appointmentId ?? null,
      input.userId ?? null,
    ],
  );
  return { id: rows[0].id as string };
}

/** Each tooth's latest finding, and every finding in order (the tooth's history). */
export async function toothChart(client: PoolClient, patientId: string) {
  const { rows } = await client.query(
    `select f.id, f.tooth, f.condition, f.surfaces, f.note, f.recorded_at, u.name as recorded_by
     from tooth_findings f left join users u on u.id = f.recorded_by
     where f.patient_id = $1 order by f.recorded_at desc, f.id`,
    [patientId],
  );
  const history = rows.map((r) => ({
    id: r.id as string,
    tooth: Number(r.tooth),
    condition: r.condition as ToothCondition,
    surfaces: r.surfaces as string | null,
    note: r.note as string | null,
    recordedAt: r.recorded_at as Date,
    recordedBy: r.recorded_by as string | null,
  }));
  const teeth: Record<number, (typeof history)[number]> = {};
  for (const f of history) teeth[f.tooth] ??= f;
  return { teeth, history };
}

// ------------------------------------------------------------------------------------------ prescriptions

export interface RxItem {
  drug: string;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  instructions?: string | null;
}

function cleanItems(items: RxItem[]): RxItem[] {
  const out = items
    .map((i) => ({
      drug: (i.drug ?? "").trim().slice(0, 120),
      dose: clean(i.dose)?.slice(0, 60) ?? null,
      frequency: clean(i.frequency)?.slice(0, 60) ?? null,
      duration: clean(i.duration)?.slice(0, 60) ?? null,
      instructions: clean(i.instructions)?.slice(0, 160) ?? null,
    }))
    .filter((i) => i.drug);
  if (out.length > 10) throw new DomainError("invalid", "At most 10 medicines on one prescription");
  return out;
}

export async function listRxTemplates(client: PoolClient) {
  const { rows } = await client.query(
    `select t.id, t.name, t.items, t.advice, t.doctor_id, d.name as doctor_name
     from prescription_templates t left join doctors d on d.id = t.doctor_id
     where t.active order by t.name`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    items: r.items as RxItem[],
    advice: r.advice as string | null,
    doctorId: r.doctor_id as string | null,
    doctorName: r.doctor_name as string | null,
  }));
}

export async function saveRxTemplate(
  client: PoolClient,
  input: { id?: string; name: string; doctorId?: string | null; items: RxItem[]; advice?: string | null },
) {
  const items = cleanItems(input.items);
  if (!input.name.trim()) throw new DomainError("invalid", "Give the template a name");
  if (!items.length) throw new DomainError("invalid", "Add at least one medicine");
  const { rows } = input.id
    ? await client.query(
        "update prescription_templates set name = $2, doctor_id = $3, items = $4, advice = $5 where id = $1 returning id",
        [input.id, input.name.trim(), input.doctorId ?? null, JSON.stringify(items), clean(input.advice)],
      )
    : await client.query(
        `insert into prescription_templates (clinic_id, name, doctor_id, items, advice)
         values (app.current_clinic_id(), $1, $2, $3, $4) returning id`,
        [input.name.trim(), input.doctorId ?? null, JSON.stringify(items), clean(input.advice)],
      );
  if (!rows[0]) throw new DomainError("not_found", "Template not found");
  return { id: rows[0].id as string };
}

export async function removeRxTemplate(client: PoolClient, id: string) {
  await client.query("update prescription_templates set active = false where id = $1", [id]);
}

export async function writePrescription(
  client: PoolClient,
  input: {
    patientId: string;
    doctorId: string;
    appointmentId?: string | null;
    items: RxItem[];
    advice?: string | null;
    reviewOn?: string | null;
    userId?: string | null;
    now?: Date;
  },
) {
  const items = cleanItems(input.items);
  if (!items.length) throw new DomainError("invalid", "Add at least one medicine");
  const doctor = (await client.query("select id, active from doctors where id = $1", [input.doctorId]))
    .rows[0];
  if (!doctor) throw new DomainError("not_found", "Doctor not found");
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const now = input.now ?? new Date();
  const fy = financialYear(now, tz);
  const n = (await client.query("select app.next_doc_number('prescription', $1) as n", [fy])).rows[0]
    .n as number;
  const number = `RX/${fy}/${String(n).padStart(4, "0")}`;
  const { rows } = await client.query(
    `insert into prescriptions (clinic_id, number, patient_id, doctor_id, appointment_id, items, advice, review_on, created_by, created_at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      number,
      input.patientId,
      input.doctorId,
      input.appointmentId ?? null,
      JSON.stringify(items),
      clean(input.advice),
      input.reviewOn ?? null,
      input.userId ?? null,
      now,
    ],
  );
  return { id: rows[0].id as string, number };
}

export async function cancelPrescription(client: PoolClient, id: string, reason: string) {
  if (!reason.trim()) throw new DomainError("invalid", "Say why it is cancelled");
  const { rowCount } = await client.query(
    "update prescriptions set cancelled_at = now(), cancel_reason = $2 where id = $1 and cancelled_at is null",
    [id, reason.trim().slice(0, 300)],
  );
  if (!rowCount) throw new DomainError("invalid", "Already cancelled, or not found");
}

export async function listPrescriptions(client: PoolClient, patientId: string) {
  const { rows } = await client.query(
    `select r.id, r.number, r.items, r.advice, r.review_on, r.created_at, r.cancelled_at, r.cancel_reason,
            r.appointment_id, d.name as doctor_name
     from prescriptions r join doctors d on d.id = r.doctor_id
     where r.patient_id = $1 order by r.created_at desc limit 100`,
    [patientId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    number: r.number as string,
    items: r.items as RxItem[],
    advice: r.advice as string | null,
    reviewOn: r.review_on as string | null,
    createdAt: r.created_at as Date,
    cancelledAt: r.cancelled_at as Date | null,
    cancelReason: r.cancel_reason as string | null,
    appointmentId: r.appointment_id as string | null,
    doctorName: r.doctor_name as string,
  }));
}

function ageOf(dob: string | null, approx: number | null, at: Date): number | null {
  const year = at.getUTCFullYear();
  if (dob) return year - Number(dob.slice(0, 4));
  return approx ? year - approx : null;
}

export async function renderPrescriptionPdf(client: PoolClient, id: string): Promise<Uint8Array> {
  const r = (
    await client.query(
      `select r.*, p.name as patient_name, p.dob::text as dob, p.approx_birth_year, p.gender, p.file_number,
              d.name as doctor_name, d.qualification, d.speciality, d.registration_no,
              c.name as clinic_name, c.legal_name, c.address, c.phone as clinic_phone, c.timezone
       from prescriptions r join patients p on p.id = r.patient_id join doctors d on d.id = r.doctor_id
       join clinics c on c.id = r.clinic_id where r.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw new DomainError("not_found", "Prescription not found");
  const w = await a4(`Prescription ${r.number}`);
  letterhead(w, { name: r.clinic_name, legalName: r.legal_name, address: r.address, phone: r.clinic_phone });
  w.text(r.doctor_name, 50, 12, w.bold);
  w.right(`No. ${r.number}`, 545, 10);
  w.down(14);
  const creds = [r.qualification ?? r.speciality, r.registration_no ? `Reg. No. ${r.registration_no}` : null]
    .filter(Boolean)
    .join("   ");
  if (creds) {
    w.text(creds, 50, 10, w.font, true);
    w.down(14);
  }
  w.right(`Date: ${localDateOf(r.created_at, r.timezone)}`, 545, 10);
  w.down(10);
  w.line();
  w.down(18);
  const age = ageOf(r.dob, r.approx_birth_year, r.created_at);
  const sex = { female: "F", male: "M", other: "Other" }[r.gender as string] ?? null;
  w.text(`Patient: ${r.patient_name}`, 50, 11, w.bold);
  w.right(
    [age !== null ? `${age} y` : null, sex, r.file_number ? `File ${r.file_number}` : null]
      .filter(Boolean)
      .join(" / "),
    545,
    10,
  );
  w.down(26);
  if (r.cancelled_at) {
    w.text(`CANCELLED: ${r.cancel_reason ?? ""}`, 50, 12, w.bold);
    w.down(20);
  }
  w.text("Rx", 50, 16, w.bold);
  w.down(22);
  for (const [i, item] of (r.items as RxItem[]).entries()) {
    w.text(`${i + 1}.  ${item.drug.toUpperCase()}`, 60, 11, w.bold);
    w.down(14);
    const how = [item.dose, item.frequency, item.duration ? `for ${item.duration}` : null]
      .filter(Boolean)
      .join("  ·  ");
    if (how) {
      w.text(how, 78, 10);
      w.down(13);
    }
    if (item.instructions) {
      w.text(item.instructions, 78, 10, w.font, true);
      w.down(13);
    }
    w.down(6);
  }
  if (r.advice) {
    w.down(6);
    w.text("Advice", 50, 11, w.bold);
    w.down(14);
    for (const line of String(r.advice).split(/\n/).slice(0, 8)) {
      w.text(line.slice(0, 100), 50, 10);
      w.down(13);
    }
  }
  if (r.review_on) {
    w.down(6);
    w.text(`Review on: ${r.review_on}`, 50, 10, w.bold);
    w.down(13);
  }
  w.y = Math.min(w.y - 30, 150);
  w.right("Signature", 545, 10);
  w.down(14);
  w.right(r.doctor_name, 545, 10, w.bold);
  w.down(28);
  w.text(
    "Take medicines only as written. In an emergency, call the clinic or go to the nearest hospital.",
    50,
    8,
    w.font,
    true,
  );
  return w.pdf.save();
}

/** Sends the prescription to the patient on WhatsApp (a link valid for 7 days). */
export async function sendPrescription(
  client: PoolClient,
  id: string,
  deps: { storage: StorageProvider; now?: Date },
): Promise<{ outboxId: string | null }> {
  const r = (
    await client.query(
      `select r.id, r.number, r.cancelled_at, r.patient_id, p.name, p.phone, p.language_pref, c.name as clinic,
              c.default_language, d.name as doctor
       from prescriptions r join patients p on p.id = r.patient_id join clinics c on c.id = r.clinic_id
       join doctors d on d.id = r.doctor_id where r.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw new DomainError("not_found", "Prescription not found");
  if (r.cancelled_at) throw new DomainError("invalid", "This prescription was cancelled");
  if (!r.phone) throw new DomainError("invalid", "The patient has no phone number");
  const clinicId = (await client.query("select app.current_clinic_id() as id")).rows[0].id;
  const key = `prescriptions/${clinicId}/${r.id}.pdf`;
  await deps.storage.put({
    key,
    bytes: await renderPrescriptionPdf(client, r.id),
    contentType: "application/pdf",
  });
  await client.query("update prescriptions set pdf_key = $2 where id = $1", [r.id, key]);
  const url = await deps.storage.signedUrl(key, 7 * 86_400);
  const language =
    r.language_pref === "en" || (!r.language_pref && r.default_language === "en") ? "en" : "hi";
  const outboxId = await enqueueMessage(client, {
    to: r.phone,
    category: "transactional",
    purpose: "prescription",
    patientId: r.patient_id,
    dedupeKey: `prescription:${r.id}`,
    notBefore: deps.now,
    payload: {
      kind: "template",
      purpose: "prescription",
      language,
      params: [r.name, r.doctor, r.clinic, url],
    },
  });
  return { outboxId };
}

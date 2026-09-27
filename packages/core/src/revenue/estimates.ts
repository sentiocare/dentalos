import type { StorageProvider } from "@dentalos/adapters";
import { formatINR, romanize, type Paise } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { addDays, localDateOf } from "../time";

/**
 * Treatment estimates (Build Prompt §5.4): itemised, sent as a PDF link on WhatsApp, then followed up by the
 * estimate ladder until the patient accepts, declines, books, or it expires.
 */
export interface EstimateItem {
  label: string;
  procedureTypeId?: string | null;
  tooth?: string | null;
  qty: number;
  amountPaise: number;
}

export async function createEstimate(
  client: PoolClient,
  input: {
    patientId: string;
    planId?: string | null;
    items: EstimateItem[];
    emiNote?: string | null;
    validDays?: number;
    createdBy?: string | null;
    now?: Date;
  },
): Promise<{ id: string; totalPaise: number }> {
  if (input.items.length === 0) throw new DomainError("invalid", "Add at least one item");
  for (const i of input.items)
    if (!Number.isInteger(i.qty) || i.qty < 1 || !Number.isInteger(i.amountPaise) || i.amountPaise < 0)
      throw new DomainError("invalid", "Each item needs a quantity and an amount");
  const total = input.items.reduce((n, i) => n + i.qty * i.amountPaise, 0);
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const validUntil = addDays(localDateOf(input.now ?? new Date(), tz), input.validDays ?? 30);
  const { rows } = await client.query(
    `insert into estimates (clinic_id, patient_id, plan_id, items, total_paise, emi_note, valid_until, created_by)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.patientId,
      input.planId ?? null,
      JSON.stringify(
        input.items.map((i) => ({
          label: i.label,
          procedure_type_id: i.procedureTypeId ?? null,
          tooth: i.tooth ?? null,
          qty: i.qty,
          amount_paise: i.amountPaise,
        })),
      ),
      total,
      input.emiNote ?? null,
      validUntil,
      input.createdBy ?? null,
    ],
  );
  return { id: rows[0].id, totalPaise: total };
}

/** An estimate for the sittings of a plan that are still to do. */
export async function estimateFromPlan(
  client: PoolClient,
  planId: string,
  extra: { createdBy?: string | null; now?: Date } = {},
) {
  const plan = (await client.query("select patient_id from treatment_plans where id = $1", [planId])).rows[0];
  if (!plan) throw new DomainError("not_found", "Plan not found");
  const steps = (
    await client.query(
      `select s.procedure_type_id, pt.name, s.tooth, s.value_paise from treatment_steps s
       join procedure_types pt on pt.id = s.procedure_type_id
       where s.plan_id = $1 and s.status not in ('done', 'skipped') order by s.seq`,
      [planId],
    )
  ).rows;
  // Group identical sittings ("Root canal sitting × 3").
  const items: EstimateItem[] = [];
  for (const s of steps) {
    const same = items.find(
      (i) =>
        i.procedureTypeId === s.procedure_type_id &&
        i.amountPaise === Number(s.value_paise) &&
        i.tooth === s.tooth,
    );
    if (same) same.qty++;
    else
      items.push({
        label: s.name,
        procedureTypeId: s.procedure_type_id,
        tooth: s.tooth,
        qty: 1,
        amountPaise: Number(s.value_paise),
      });
  }
  return createEstimate(client, {
    patientId: plan.patient_id,
    planId,
    items,
    createdBy: extra.createdBy,
    now: extra.now,
  });
}

/** PDF text must stay in the standard PDF fonts: Hindi names are written in Roman letters, ₹ as "Rs.". */
const pdfText = (s: string) =>
  romanize(s)
    .replace(/₹/g, "Rs. ")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "")
    .trim();
const rupees = (paise: number) => formatINR(paise as Paise).replace("₹", "Rs. ");

export interface EstimatePdfInput {
  clinic: { name: string; address: string | null; phone: string | null };
  patientName: string;
  number: string;
  date: string;
  validUntil: string;
  items: { label: string; tooth: string | null; qty: number; amountPaise: number }[];
  totalPaise: number;
  emiNote: string | null;
  doctor: string | null;
}

export async function renderEstimatePdf(input: EstimatePdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Estimate ${input.number}`);
  pdf.setProducer("Sentio Dental OS");
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.15);
  const muted = rgb(0.4, 0.44, 0.5);
  let y = 790;
  const text = (s: string, x: number, size = 11, f = font, color = ink) =>
    page.drawText(pdfText(s), { x, y, size, font: f, color });
  const right = (s: string, xRight: number, size = 11, f = font) => {
    const t = pdfText(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f, color: ink });
  };

  text(input.clinic.name, 50, 18, bold);
  y -= 18;
  if (input.clinic.address) {
    text(input.clinic.address, 50, 10, font, muted);
    y -= 14;
  }
  if (input.clinic.phone) {
    text(`Phone: ${input.clinic.phone}`, 50, 10, font, muted);
    y -= 14;
  }
  y -= 20;
  text("Treatment estimate", 50, 15, bold);
  right(`No. ${input.number}`, 545, 10);
  y -= 22;
  text(`Patient: ${input.patientName}`, 50);
  right(`Date: ${input.date}`, 545, 10);
  y -= 16;
  if (input.doctor) {
    text(`Doctor: ${input.doctor}`, 50);
    y -= 16;
  }
  y -= 14;

  text("Treatment", 50, 10, bold, muted);
  text("Tooth", 330, 10, bold, muted);
  text("Qty", 385, 10, bold, muted);
  right("Amount", 545, 10, bold);
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: muted });
  y -= 16;
  for (const item of input.items) {
    text(item.label.slice(0, 48), 50);
    text(item.tooth ?? "", 330);
    text(String(item.qty), 390);
    right(rupees(item.qty * item.amountPaise), 545);
    y -= 18;
  }
  page.drawLine({ start: { x: 50, y: y + 8 }, end: { x: 545, y: y + 8 }, thickness: 0.5, color: muted });
  y -= 8;
  text("Total", 50, 12, bold);
  right(rupees(input.totalPaise), 545, 12, bold);
  y -= 30;
  if (input.emiNote) {
    text(input.emiNote.slice(0, 90), 50, 10);
    y -= 16;
  }
  text(
    `Valid until ${input.validUntil}. This is an estimate; the final amount may change after examination.`,
    50,
    9,
    font,
    muted,
  );
  return pdf.save();
}

/**
 * Makes the PDF, stores it, and queues the WhatsApp message with a link (valid 30 days) and buttons to go
 * ahead or ask for a call. Idempotent per estimate.
 */
export async function sendEstimate(
  client: PoolClient,
  estimateId: string,
  deps: { storage: StorageProvider; now?: Date },
): Promise<{ outboxId: string | null }> {
  const e = (
    await client.query(
      `select e.*, p.name as patient_name, p.phone, p.language_pref, c.name as clinic, c.address, c.phone as clinic_phone,
              c.default_language, c.timezone, d.name as doctor
       from estimates e join patients p on p.id = e.patient_id join clinics c on c.id = e.clinic_id
       left join treatment_plans tp on tp.id = e.plan_id left join doctors d on d.id = tp.doctor_id
       where e.id = $1`,
      [estimateId],
    )
  ).rows[0];
  if (!e) throw new DomainError("not_found", "Estimate not found");
  if (!["draft", "sent"].includes(e.status))
    throw new DomainError("invalid", "This estimate was already decided");
  if (!e.phone) throw new DomainError("invalid", "The patient has no phone number");
  const now = deps.now ?? new Date();
  const pdf = await renderEstimatePdf({
    clinic: { name: e.clinic, address: e.address, phone: e.clinic_phone },
    patientName: e.patient_name,
    number: e.id.slice(0, 8).toUpperCase(),
    date: localDateOf(now, e.timezone),
    validUntil: typeof e.valid_until === "string" ? e.valid_until : localDateOf(e.valid_until, "UTC"),
    items: e.items.map((i: { label: string; tooth: string | null; qty: number; amount_paise: number }) => ({
      label: i.label,
      tooth: i.tooth,
      qty: i.qty,
      amountPaise: i.amount_paise,
    })),
    totalPaise: Number(e.total_paise),
    emiNote: e.emi_note,
    doctor: e.doctor,
  });
  const key = `estimates/${e.clinic_id}/${e.id}.pdf`;
  await deps.storage.put({ key, bytes: pdf, contentType: "application/pdf" });
  const url = await deps.storage.signedUrl(key, 30 * 24 * 3600);
  await client.query(
    "update estimates set status = 'sent', sent_at = coalesce(sent_at, $2), document_key = $3 where id = $1",
    [e.id, now, key],
  );
  const language =
    e.language_pref === "en" || (!e.language_pref && e.default_language === "en") ? "en" : "hi";
  const outboxId = await enqueueMessage(client, {
    to: e.phone,
    category: "transactional",
    purpose: "estimate_ready",
    patientId: e.patient_id,
    dedupeKey: `estimate:${e.id}:sent`,
    payload: {
      kind: "template",
      purpose: "estimate_ready",
      language,
      params: [e.patient_name, e.clinic, formatINR(Number(e.total_paise) as Paise), url],
      buttonPayloads: [`estimate_ok:${e.id}`, `estimate_call:${e.id}`],
    },
  });
  return { outboxId };
}

export async function decideEstimate(
  client: PoolClient,
  estimateId: string,
  decision: "accepted" | "declined",
) {
  const { rowCount } = await client.query(
    "update estimates set status = $2, decided_at = now() where id = $1 and status in ('draft', 'sent')",
    [estimateId, decision],
  );
  if (!rowCount) throw new DomainError("invalid", "This estimate was already decided");
  if (decision === "accepted")
    await client.query(
      "update treatment_plans set status = 'accepted', accepted_at = now() where id = (select plan_id from estimates where id = $1) and status = 'proposed'",
      [estimateId],
    );
}

/** Nightly: estimates past their date expire (and their follow-ups stop). */
export async function expireEstimates(client: PoolClient, now: Date = new Date()): Promise<number> {
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const { rowCount } = await client.query(
    "update estimates set status = 'expired', decided_at = now() where status in ('draft', 'sent') and valid_until < $1",
    [localDateOf(now, tz)],
  );
  return rowCount ?? 0;
}

export async function patientEstimates(client: PoolClient, patientId: string) {
  return (
    await client.query(
      `select id, plan_id, items, total_paise, emi_note, status, valid_until::text, sent_at, decided_at, created_at
       from estimates where patient_id = $1 order by created_at desc`,
      [patientId],
    )
  ).rows;
}

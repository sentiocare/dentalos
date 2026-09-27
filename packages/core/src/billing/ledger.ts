import type { PaymentAccount, PaymentProvider, StorageProvider } from "@dentalos/adapters";
import { decryptSecret, encryptSecret, formatINR, type Paise } from "@dentalos/shared";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { a4, letterhead, pdfRupees } from "../pdf";
import { localDateOf } from "../time";

/**
 * The clinic's own money (Build Prompt §5.10, PLAN §4.7): what each patient was charged and paid, receipts
 * and invoices numbered per financial year, payment links on the clinic's own gateway account.
 * The ledger is append-only: a mistake is undone with a reversing entry, never edited.
 */
export type PaymentMethod = "cash" | "upi" | "card" | "bank" | "gateway_link";

/** Indian financial year of a date in the clinic's time zone: April to March, e.g. "2026-27". */
export function financialYear(at: Date, timezone: string): string {
  const [y, m] = localDateOf(at, timezone).split("-").map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** GST included in a price: amount × rate / (100% + rate), rounded to the paisa. */
export function gstIncluded(amountPaise: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  return Math.round((amountPaise * rateBps) / (10_000 + rateBps));
}

async function clinicRow(client: PoolClient) {
  return (
    await client.query(
      `select name, legal_name, gstin, phone, address, city, state, timezone, default_language, settings
       from clinics where id = app.current_clinic_id()`,
    )
  ).rows[0];
}

async function nextNumber(client: PoolClient, kind: "receipt" | "invoice", fy: string, prefix: string) {
  const n = (await client.query("select app.next_doc_number($1, $2) as n", [kind, fy])).rows[0].n as number;
  return `${prefix}/${fy}/${String(n).padStart(4, "0")}`;
}

async function existing(client: PoolClient, dedupeKey: string | undefined) {
  if (!dedupeKey) return null;
  return (
    (await client.query("select * from patient_ledger where dedupe_key = $1", [dedupeKey])).rows[0] ?? null
  );
}

// ------------------------------------------------------------------------------------------ entries

export async function addCharge(
  client: PoolClient,
  input: {
    patientId: string;
    amountPaise: number;
    description: string;
    procedureTypeId?: string | null;
    appointmentId?: string | null;
    treatmentStepId?: string | null;
    dedupeKey?: string;
    userId?: string | null;
    /** When it happened, if not now (imports, demo data). */
    at?: Date;
  },
): Promise<{ id: string; gstPaise: number }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0)
    throw new DomainError("invalid", "Enter an amount above zero");
  const prior = await existing(client, input.dedupeKey);
  if (prior) return { id: prior.id, gstPaise: Number(prior.gst_paise) };
  let rate = 0;
  if (input.procedureTypeId) {
    const p = (
      await client.query("select gst_mode, gst_rate_bps from procedure_types where id = $1", [
        input.procedureTypeId,
      ])
    ).rows[0];
    if (!p) throw new DomainError("not_found", "Treatment not found");
    rate = p.gst_mode === "taxable" ? p.gst_rate_bps : 0;
  }
  const gst = gstIncluded(input.amountPaise, rate);
  const { rows } = await client.query(
    `insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description, procedure_type_id, appointment_id,
                                 treatment_step_id, gst_rate_bps, gst_paise, dedupe_key, created_by, created_at)
     values (app.current_clinic_id(), $1, 'charge', $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now())) returning id`,
    [
      input.patientId,
      input.amountPaise,
      input.description.trim().slice(0, 200),
      input.procedureTypeId ?? null,
      input.appointmentId ?? null,
      input.treatmentStepId ?? null,
      rate,
      gst,
      input.dedupeKey ?? null,
      input.userId ?? null,
      input.at ?? null,
    ],
  );
  return { id: rows[0].id, gstPaise: gst };
}

/** Records money received and issues the next receipt number. Same dedupe key → same payment. */
export async function recordPayment(
  client: PoolClient,
  input: {
    patientId: string;
    amountPaise: number;
    method: PaymentMethod;
    reference?: string | null;
    description?: string;
    appointmentId?: string | null;
    paymentLinkId?: string | null;
    dedupeKey?: string;
    userId?: string | null;
    now?: Date;
  },
): Promise<{ id: string; receiptId: string; receiptNumber: string; duplicate: boolean }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0)
    throw new DomainError("invalid", "Enter an amount above zero");
  const prior = await existing(client, input.dedupeKey);
  if (prior) {
    const r = (await client.query("select id, number from receipts where ledger_id = $1", [prior.id]))
      .rows[0];
    return { id: prior.id, receiptId: r.id, receiptNumber: r.number, duplicate: true };
  }
  const clinic = await clinicRow(client);
  const now = input.now ?? new Date();
  const { rows } = await client.query(
    `insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, method, description, reference, appointment_id,
                                 payment_link_id, dedupe_key, created_by, created_at)
     values (app.current_clinic_id(), $1, 'payment', $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      input.patientId,
      input.amountPaise,
      input.method,
      (input.description ?? "Payment received").slice(0, 200),
      input.reference?.slice(0, 100) ?? null,
      input.appointmentId ?? null,
      input.paymentLinkId ?? null,
      input.dedupeKey ?? null,
      input.userId ?? null,
      now,
    ],
  );
  const fy = financialYear(now, clinic.timezone);
  const number = await nextNumber(client, "receipt", fy, clinic.settings?.billing?.receiptPrefix ?? "R");
  const receipt = await client.query(
    `insert into receipts (clinic_id, number, fy, patient_id, ledger_id, amount_paise, method, issued_at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [number, fy, input.patientId, rows[0].id, input.amountPaise, input.method, now],
  );
  return { id: rows[0].id, receiptId: receipt.rows[0].id, receiptNumber: number, duplicate: false };
}

/** A discount (negative) or a correction (positive) with a reason. */
export async function addAdjustment(
  client: PoolClient,
  input: { patientId: string; amountPaise: number; description: string; userId?: string | null },
): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise === 0)
    throw new DomainError("invalid", "Enter a non-zero amount");
  if (!input.description.trim()) throw new DomainError("invalid", "Write the reason");
  const { rows } = await client.query(
    `insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description, created_by)
     values (app.current_clinic_id(), $1, 'adjustment', $2, $3, $4) returning id`,
    [input.patientId, input.amountPaise, input.description.trim().slice(0, 200), input.userId ?? null],
  );
  return { id: rows[0].id };
}

/** Money given back to the patient, against an earlier payment. */
export async function refundPayment(
  client: PoolClient,
  input: {
    paymentId: string;
    amountPaise: number;
    method: PaymentMethod;
    reason: string;
    userId?: string | null;
  },
): Promise<{ id: string }> {
  const pay = (
    await client.query("select * from patient_ledger where id = $1 and kind = 'payment'", [input.paymentId])
  ).rows[0];
  if (!pay) throw new DomainError("not_found", "Payment not found");
  const refunded = Number(
    (
      await client.query(
        "select coalesce(sum(amount_paise), 0) as s from patient_ledger where kind = 'refund' and reference = $1",
        [`refund-of:${pay.id}`],
      )
    ).rows[0].s,
  );
  if (input.amountPaise <= 0 || input.amountPaise + refunded > Number(pay.amount_paise))
    throw new DomainError("invalid", "A refund cannot be more than what was paid");
  const { rows } = await client.query(
    `insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, method, description, reference, created_by)
     values (app.current_clinic_id(), $1, 'refund', $2, $3, $4, $5, $6) returning id`,
    [
      pay.patient_id,
      input.amountPaise,
      input.method,
      `Refund: ${input.reason.trim()}`.slice(0, 200),
      `refund-of:${pay.id}`,
      input.userId ?? null,
    ],
  );
  return { id: rows[0].id };
}

/**
 * Undoes an entry made by mistake with an equal and opposite adjustment. A reversed payment's receipt is
 * marked cancelled (its number is never reused). Invoiced charges are corrected with a credit instead.
 */
export async function reverseEntry(
  client: PoolClient,
  input: { entryId: string; reason: string; userId?: string | null },
): Promise<{ id: string }> {
  const e = (await client.query("select * from patient_ledger where id = $1", [input.entryId])).rows[0];
  if (!e) throw new DomainError("not_found", "Entry not found");
  if (e.reverses_id) throw new DomainError("invalid", "This entry is itself a correction");
  if (!input.reason.trim()) throw new DomainError("invalid", "Write the reason");
  if ((await client.query("select 1 from patient_ledger where reverses_id = $1", [e.id])).rowCount)
    throw new DomainError("conflict", "Already reversed");
  if (
    e.kind === "charge" &&
    (await client.query("select 1 from invoice_charges where ledger_id = $1", [e.id])).rowCount
  )
    throw new DomainError("conflict", "This charge is on an invoice; add a discount instead");
  if (e.kind === "refund") throw new DomainError("invalid", "A refund cannot be reversed; record a payment");
  // The opposite effect on the balance: a charge (+) is undone by −, a payment (−) by +.
  const amount = e.kind === "payment" ? Number(e.amount_paise) : -Number(e.amount_paise);
  const { rows } = await client.query(
    `insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description, reverses_id, created_by)
     values (app.current_clinic_id(), $1, 'adjustment', $2, $3, $4, $5) returning id`,
    [e.patient_id, amount, `Correction: ${input.reason.trim()}`.slice(0, 200), e.id, input.userId ?? null],
  );
  if (e.kind === "payment")
    await client.query("update receipts set cancelled_at = now() where ledger_id = $1", [e.id]);
  return { id: rows[0].id };
}

export interface LedgerEntry {
  id: string;
  kind: "charge" | "payment" | "adjustment" | "refund";
  amountPaise: number;
  method: PaymentMethod | null;
  description: string;
  reference: string | null;
  gstPaise: number;
  createdAt: Date;
  createdBy: string | null;
  receipt: { id: string; number: string; cancelled: boolean } | null;
  invoice: { id: string; number: string } | null;
  reversed: boolean;
  reversesId: string | null;
}

export async function patientAccount(client: PoolClient, patientId: string) {
  const { rows } = await client.query(
    `select l.*, coalesce(m.display_name, u.name) as by_name,
            r.id as receipt_id, r.number as receipt_number, r.cancelled_at,
            i.id as invoice_id2, i.number as invoice_number,
            exists (select 1 from patient_ledger x where x.reverses_id = l.id) as reversed
     from patient_ledger l
     left join users u on u.id = l.created_by
     left join clinic_memberships m on m.user_id = l.created_by and m.clinic_id = l.clinic_id
     left join receipts r on r.ledger_id = l.id
     left join invoice_charges ic on ic.ledger_id = l.id
     left join invoices i on i.id = ic.invoice_id
     where l.patient_id = $1 order by l.created_at, l.id`,
    [patientId],
  );
  const entries: LedgerEntry[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountPaise: Number(r.amount_paise),
    method: r.method,
    description: r.description,
    reference: r.reference,
    gstPaise: Number(r.gst_paise),
    createdAt: r.created_at,
    createdBy: r.by_name ?? null,
    receipt: r.receipt_id
      ? { id: r.receipt_id, number: r.receipt_number, cancelled: !!r.cancelled_at }
      : null,
    invoice: r.invoice_id2 ? { id: r.invoice_id2, number: r.invoice_number } : null,
    reversed: r.reversed,
    reversesId: r.reverses_id,
  }));
  const balancePaise = entries.reduce(
    (s, e) => s + (e.kind === "payment" ? -e.amountPaise : e.amountPaise),
    0,
  );
  const uninvoiced = entries.filter((e) => e.kind === "charge" && !e.invoice && !e.reversed);
  return { entries, balancePaise, uninvoicedChargeIds: uninvoiced.map((e) => e.id) };
}

// ------------------------------------------------------------------------------------------ invoices

export interface InvoiceLine {
  description: string;
  sac: string;
  taxablePaise: number;
  gstRateBps: number;
  gstPaise: number;
  totalPaise: number;
}

/**
 * An invoice for charges not yet invoiced. "Tax invoice" when any line carries GST (e.g. cosmetic work),
 * otherwise "Bill of supply" (healthcare services are exempt). Amounts include GST (ASSUMPTIONS A-45).
 */
export async function createInvoice(
  client: PoolClient,
  input: { patientId: string; chargeIds?: string[]; userId?: string | null; now?: Date },
): Promise<{ id: string; number: string; totalPaise: number }> {
  const clinic = await clinicRow(client);
  const account = await patientAccount(client, input.patientId);
  const ids = input.chargeIds?.length
    ? input.chargeIds.filter((id) => account.uninvoicedChargeIds.includes(id))
    : account.uninvoicedChargeIds;
  if (!ids.length) throw new DomainError("invalid", "There is nothing to invoice");
  if (input.chargeIds && ids.length !== input.chargeIds.length)
    throw new DomainError("conflict", "Some charges are already invoiced or were reversed");
  const charges = account.entries.filter((e) => ids.includes(e.id));
  const sac = clinic.settings?.billing?.sac ?? "999312";
  const meta = new Map<string, { rate: number; sac: string | null }>(
    (
      await client.query(
        `select l.id, l.gst_rate_bps, pt.sac_code from patient_ledger l
         left join procedure_types pt on pt.id = l.procedure_type_id where l.id = any($1)`,
        [ids],
      )
    ).rows.map((r) => [r.id, { rate: r.gst_rate_bps, sac: r.sac_code }]),
  );
  const lines: InvoiceLine[] = charges.map((c) => ({
    description: c.description,
    sac: meta.get(c.id)?.sac || sac,
    taxablePaise: c.amountPaise - c.gstPaise,
    gstRateBps: meta.get(c.id)?.rate ?? 0,
    gstPaise: c.gstPaise,
    totalPaise: c.amountPaise,
  }));
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const gst = lines.reduce((s, l) => s + l.gstPaise, 0);
  const total = lines.reduce((s, l) => s + l.totalPaise, 0);
  const now = input.now ?? new Date();
  const fy = financialYear(now, clinic.timezone);
  const number = await nextNumber(client, "invoice", fy, clinic.settings?.billing?.invoicePrefix ?? "INV");
  const { rows } = await client.query(
    `insert into invoices (clinic_id, number, fy, patient_id, doc_type, lines, taxable_paise, gst_paise, total_paise, issued_at, created_by)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      number,
      fy,
      input.patientId,
      gst > 0 ? "tax_invoice" : "bill_of_supply",
      JSON.stringify(lines),
      taxable,
      gst,
      total,
      now,
      input.userId ?? null,
    ],
  );
  for (const id of ids)
    await client.query(
      "insert into invoice_charges (clinic_id, invoice_id, ledger_id) values (app.current_clinic_id(), $1, $2)",
      [rows[0].id, id],
    );
  return { id: rows[0].id, number, totalPaise: total };
}

// ------------------------------------------------------------------------------------------ PDFs

async function patientName(client: PoolClient, id: string) {
  return (await client.query("select name, phone, address from patients where id = $1", [id])).rows[0];
}

export async function renderReceiptPdf(client: PoolClient, receiptId: string): Promise<Uint8Array> {
  const r = (await client.query("select * from receipts where id = $1", [receiptId])).rows[0];
  if (!r) throw new DomainError("not_found", "Receipt not found");
  const clinic = await clinicRow(client);
  const p = await patientName(client, r.patient_id);
  const entry = (await client.query("select reference from patient_ledger where id = $1", [r.ledger_id]))
    .rows[0];
  const w = await a4(`Receipt ${r.number}`);
  letterhead(w, {
    name: clinic.name,
    legalName: clinic.legal_name,
    address: clinic.address,
    phone: clinic.phone,
    gstin: clinic.gstin,
  });
  w.text(r.cancelled_at ? "Payment receipt (CANCELLED)" : "Payment receipt", 50, 15, w.bold);
  w.right(`No. ${r.number}`, 545, 10);
  w.down(22);
  w.text(`Received from: ${p.name}`, 50);
  w.right(`Date: ${localDateOf(r.issued_at, clinic.timezone)}`, 545, 10);
  w.down(26);
  w.text("Amount received", 50, 12, w.bold);
  w.right(pdfRupees(Number(r.amount_paise)), 545, 12, w.bold);
  w.down(18);
  const method = {
    cash: "Cash",
    upi: "UPI",
    card: "Card",
    bank: "Bank transfer",
    gateway_link: "Online (payment link)",
  }[r.method as PaymentMethod];
  w.text(`Paid by: ${method}${entry?.reference ? ` (ref. ${entry.reference})` : ""}`, 50, 10);
  w.down(30);
  w.text("This is a computer-generated receipt.", 50, 9, w.font, true);
  return w.pdf.save();
}

export async function renderInvoicePdf(client: PoolClient, invoiceId: string): Promise<Uint8Array> {
  const inv = (await client.query("select * from invoices where id = $1", [invoiceId])).rows[0];
  if (!inv) throw new DomainError("not_found", "Invoice not found");
  const clinic = await clinicRow(client);
  const p = await patientName(client, inv.patient_id);
  const w = await a4(`Invoice ${inv.number}`);
  letterhead(w, {
    name: clinic.name,
    legalName: clinic.legal_name,
    address: clinic.address,
    phone: clinic.phone,
    gstin: clinic.gstin,
  });
  w.text(inv.doc_type === "tax_invoice" ? "Tax invoice" : "Bill of supply", 50, 15, w.bold);
  w.right(`No. ${inv.number}`, 545, 10);
  w.down(22);
  w.text(`Patient: ${p.name}`, 50);
  w.right(`Date: ${localDateOf(inv.issued_at, clinic.timezone)}`, 545, 10);
  w.down(26);
  w.text("Service", 50, 10, w.bold, true);
  w.text("SAC", 300, 10, w.bold, true);
  w.right("Taxable", 400, 10, w.bold);
  w.right("GST", 470, 10, w.bold);
  w.right("Amount", 545, 10, w.bold);
  w.down(6);
  w.line();
  w.down(16);
  for (const l of inv.lines as InvoiceLine[]) {
    w.text(l.description.slice(0, 44), 50, 10);
    w.text(l.sac, 300, 10);
    w.right(pdfRupees(l.taxablePaise), 400, 10);
    w.right(l.gstPaise ? `${pdfRupees(l.gstPaise)} (${l.gstRateBps / 100}%)` : "-", 470, 10);
    w.right(pdfRupees(l.totalPaise), 545, 10);
    w.down(16);
  }
  w.y += 8;
  w.line();
  w.down(16);
  if (Number(inv.gst_paise) > 0) {
    // Within the state: GST is split equally into central and state tax.
    const cgst = Math.floor(Number(inv.gst_paise) / 2);
    w.text("CGST", 300, 10);
    w.right(pdfRupees(cgst), 545, 10);
    w.down(14);
    w.text("SGST", 300, 10);
    w.right(pdfRupees(Number(inv.gst_paise) - cgst), 545, 10);
    w.down(16);
  }
  w.text("Total", 50, 12, w.bold);
  w.right(pdfRupees(Number(inv.total_paise)), 545, 12, w.bold);
  w.down(30);
  w.text(
    inv.doc_type === "tax_invoice"
      ? "Prices include GST."
      : "Healthcare services by a clinical establishment are exempt from GST.",
    50,
    9,
    w.font,
    true,
  );
  return w.pdf.save();
}

// ------------------------------------------------------------------------------------------ gateway

/** Connects the clinic's own Razorpay account (patients pay the clinic directly). Keys are stored encrypted. */
export async function connectPaymentAccount(client: PoolClient, key: Buffer, account: PaymentAccount) {
  if (!/^rzp_(live|test)_\w{6,}$/.test(account.keyId))
    throw new DomainError("invalid", "The key id starts with rzp_live_ or rzp_test_");
  if (account.keySecret.length < 8 || account.webhookSecret.length < 8)
    throw new DomainError("invalid", "Enter the key secret and the webhook secret");
  await client.query("update clinic_channels set active = false where kind = 'payments'");
  await client.query(
    `insert into clinic_channels (clinic_id, kind, external_id, display_phone, credentials_encrypted, active)
     values (app.current_clinic_id(), 'payments', $1, $1, $2, true)
     on conflict (kind, external_id) do update set credentials_encrypted = excluded.credentials_encrypted, active = true`,
    [account.keyId, encryptSecret(key, JSON.stringify(account))],
  );
}

export async function getPaymentAccount(
  client: PoolClient,
  key: Buffer | null,
): Promise<PaymentAccount | null> {
  const row = (
    await client.query(
      "select credentials_encrypted from clinic_channels where kind = 'payments' and active order by updated_at desc limit 1",
    )
  ).rows[0];
  if (!row?.credentials_encrypted || !key) return null;
  return JSON.parse(decryptSecret(key, row.credentials_encrypted)) as PaymentAccount;
}

export async function paymentAccountStatus(client: PoolClient) {
  const row = (
    await client.query("select external_id from clinic_channels where kind = 'payments' and active limit 1")
  ).rows[0];
  return row ? { connected: true, keyId: row.external_id as string } : { connected: false };
}

/**
 * A payment link for a patient on the clinic's own gateway account. The reference carries our link id, so
 * the webhook finds the clinic and the link without trusting anything else in the payload.
 * Without a connected account, links are made on the default provider (tests, and the demo).
 */
export async function createPatientPaymentLink(
  client: PoolClient,
  deps: { payments: PaymentProvider; account: PaymentAccount | null; requireAccount?: boolean },
  input: {
    patientId: string;
    amountPaise: number;
    purpose: "dues" | "deposit" | "other";
    appointmentId?: string | null;
    description?: string;
    now?: Date;
  },
): Promise<{ id: string; url: string }> {
  if (deps.requireAccount && !deps.account)
    throw new DomainError("invalid", "Connect the clinic's Razorpay account first (Settings → Payments)");
  const p = (
    await client.query("select phone from patients where id = $1 and deleted_at is null", [input.patientId])
  ).rows[0];
  if (!p?.phone) throw new DomainError("invalid", "The patient has no phone number");
  const clinic = await clinicRow(client);
  const id = randomUUID();
  const expires = new Date((input.now ?? new Date()).getTime() + 14 * 86_400_000);
  const link = await deps.payments.createPaymentLink(
    {
      amountPaise: input.amountPaise,
      description:
        input.description ??
        (input.purpose === "deposit"
          ? `Advance for your appointment at ${clinic.name}`
          : `Payment to ${clinic.name}`),
      customerPhone: p.phone,
      referenceId: `plink:${id}`,
      expiresAt: expires,
    },
    deps.account ?? undefined,
  );
  await client.query(
    `insert into payment_links (id, clinic_id, patient_id, appointment_id, purpose, amount_paise, provider, provider_link_id, url)
     values ($1, app.current_clinic_id(), $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.patientId,
      input.appointmentId ?? null,
      input.purpose,
      input.amountPaise,
      deps.payments.name,
      link.providerLinkId,
      link.url,
    ],
  );
  return { id, url: link.url };
}

/**
 * A patient paid a link: record the payment (once, however often the gateway retries), mark the link
 * paid and, for an advance, the appointment's deposit. Returns the receipt for sending on WhatsApp.
 */
export async function paymentLinkPaid(
  client: PoolClient,
  input: { linkId: string; providerPaymentId: string; amountPaise: number; at: Date },
): Promise<{ receiptId: string; receiptNumber: string; duplicate: boolean } | null> {
  const link = (await client.query("select * from payment_links where id = $1", [input.linkId])).rows[0];
  if (!link) return null;
  const paid = await recordPayment(client, {
    patientId: link.patient_id,
    amountPaise: input.amountPaise,
    method: "gateway_link",
    reference: input.providerPaymentId,
    description: link.purpose === "deposit" ? "Advance paid online" : "Paid online",
    appointmentId: link.appointment_id,
    paymentLinkId: link.id,
    dedupeKey: `gw:${input.providerPaymentId}`,
    now: input.at,
  });
  await client.query(
    "update payment_links set status = 'paid', paid_at = coalesce(paid_at, $2) where id = $1",
    [link.id, input.at],
  );
  if (link.purpose === "deposit" && link.appointment_id)
    await client.query(
      "update appointments set deposit_status = 'paid' where id = $1 and deposit_status = 'requested'",
      [link.appointment_id],
    );
  // Paying the dues ends the dues reminders.
  if (link.purpose === "dues")
    await client.query(
      "update followup_runs set status = 'stopped_success', finished_at = now() where kind = 'dues' and patient_id = $1 and status = 'active'",
      [link.patient_id],
    );
  return { receiptId: paid.receiptId, receiptNumber: paid.receiptNumber, duplicate: paid.duplicate };
}

/** Sends a receipt as a PDF link on WhatsApp (utility template, allowed outside the 24-hour window). */
export async function sendReceipt(
  client: PoolClient,
  receiptId: string,
  deps: { storage: StorageProvider; now?: Date },
): Promise<{ outboxId: string | null }> {
  const r = (
    await client.query(
      `select r.*, p.name, p.phone, p.language_pref, c.name as clinic, c.default_language
       from receipts r join patients p on p.id = r.patient_id join clinics c on c.id = r.clinic_id where r.id = $1`,
      [receiptId],
    )
  ).rows[0];
  if (!r) throw new DomainError("not_found", "Receipt not found");
  if (!r.phone) throw new DomainError("invalid", "The patient has no phone number");
  const clinicId = (await client.query("select app.current_clinic_id() as id")).rows[0].id;
  const key = `receipts/${clinicId}/${r.id}.pdf`;
  await deps.storage.put({
    key,
    bytes: await renderReceiptPdf(client, r.id),
    contentType: "application/pdf",
  });
  await client.query("update receipts set pdf_key = $2 where id = $1", [r.id, key]);
  const url = await deps.storage.signedUrl(key, 30 * 86_400);
  const language =
    r.language_pref === "en" || (!r.language_pref && r.default_language === "en") ? "en" : "hi";
  const id = await enqueueMessage(client, {
    to: r.phone,
    category: "transactional",
    purpose: "payment_receipt",
    patientId: r.patient_id,
    dedupeKey: `receipt:${r.id}`,
    notBefore: deps.now,
    payload: {
      kind: "template",
      purpose: "payment_receipt",
      language,
      params: [r.name, formatINR(Number(r.amount_paise) as Paise), r.clinic, url],
    },
  });
  return { outboxId: id };
}

// ------------------------------------------------------------------------------------------ reports

/** Money received in a period, by day and by method, and what patients still owe. */
export async function collections(client: PoolClient, input: { from: Date; to: Date }) {
  const clinic = await clinicRow(client);
  const tz = clinic.timezone;
  const byDay = await client.query(
    `select to_char(created_at at time zone $3, 'YYYY-MM-DD') as day,
            sum(amount_paise) filter (where kind = 'payment')::bigint as received,
            coalesce(sum(amount_paise) filter (where kind = 'refund'), 0)::bigint as refunded,
            sum(amount_paise) filter (where kind = 'payment' and method = 'cash')::bigint as cash,
            sum(amount_paise) filter (where kind = 'payment' and method = 'upi')::bigint as upi,
            sum(amount_paise) filter (where kind = 'payment' and method = 'card')::bigint as card,
            sum(amount_paise) filter (where kind = 'payment' and method = 'bank')::bigint as bank,
            sum(amount_paise) filter (where kind = 'payment' and method = 'gateway_link')::bigint as online
     from patient_ledger l
     where kind in ('payment', 'refund') and created_at >= $1 and created_at < $2
       and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)
     group by 1 order by 1`,
    [input.from, input.to, tz],
  );
  const charged = await client.query(
    `select coalesce(sum(amount_paise), 0)::bigint as s from patient_ledger l
     where kind = 'charge' and created_at >= $1 and created_at < $2
       and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)`,
    [input.from, input.to],
  );
  const dues = await client.query(
    `select count(*)::int as patients, coalesce(sum(balance_paise), 0)::bigint as total
     from patient_balances where balance_paise > 0`,
  );
  const n = (v: unknown) => Number(v ?? 0);
  const days = byDay.rows.map((r) => ({
    day: r.day as string,
    receivedPaise: n(r.received),
    refundedPaise: n(r.refunded),
    byMethod: { cash: n(r.cash), upi: n(r.upi), card: n(r.card), bank: n(r.bank), online: n(r.online) },
  }));
  const sum = (f: (d: (typeof days)[number]) => number) => days.reduce((s, d) => s + f(d), 0);
  return {
    days,
    totals: {
      chargedPaise: n(charged.rows[0].s),
      receivedPaise: sum((d) => d.receivedPaise),
      refundedPaise: sum((d) => d.refundedPaise),
      byMethod: {
        cash: sum((d) => d.byMethod.cash),
        upi: sum((d) => d.byMethod.upi),
        card: sum((d) => d.byMethod.card),
        bank: sum((d) => d.byMethod.bank),
        online: sum((d) => d.byMethod.online),
      },
    },
    dues: { patients: dues.rows[0].patients as number, totalPaise: n(dues.rows[0].total) },
  };
}

/** Patients who owe money, largest first, with how long it has been owed. */
export async function duesList(client: PoolClient, limit = 200) {
  const { rows } = await client.query(
    `select b.patient_id, b.balance_paise, b.last_payment_at, b.first_charge_at, p.name, p.phone, p.file_number,
            (select max(created_at) from patient_ledger l where l.patient_id = b.patient_id and l.kind = 'charge') as last_charge_at,
            exists (select 1 from followup_runs r where r.kind = 'dues' and r.patient_id = b.patient_id and r.status = 'active') as reminding
     from patient_balances b join patients p on p.id = b.patient_id
     where b.balance_paise > 0 and p.deleted_at is null order by b.balance_paise desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    patientId: r.patient_id as string,
    name: r.name as string,
    fileNumber: r.file_number as string | null,
    phone: r.phone as string | null,
    balancePaise: Number(r.balance_paise),
    lastChargeAt: r.last_charge_at as Date | null,
    lastPaymentAt: r.last_payment_at as Date | null,
    reminding: r.reminding as boolean,
  }));
}

/** Every ledger row in a period, flat, for the Excel export (the dashboard turns it into a sheet). */
export async function ledgerExport(client: PoolClient, input: { from: Date; to: Date }) {
  const clinic = await clinicRow(client);
  const { rows } = await client.query(
    `select to_char(l.created_at at time zone $3, 'YYYY-MM-DD HH24:MI') as at, p.file_number, p.name, l.kind, l.description,
            l.method, l.reference, l.amount_paise, l.gst_paise, r.number as receipt, i.number as invoice,
            l.reverses_id is not null as correction
     from patient_ledger l join patients p on p.id = l.patient_id
     left join receipts r on r.ledger_id = l.id
     left join invoice_charges ic on ic.ledger_id = l.id left join invoices i on i.id = ic.invoice_id
     where l.created_at >= $1 and l.created_at < $2 order by l.created_at, l.id`,
    [input.from, input.to, clinic.timezone],
  );
  return rows.map((r) => ({
    at: r.at as string,
    fileNumber: r.file_number as string | null,
    patient: r.name as string,
    kind: r.kind as string,
    description: r.description as string,
    method: r.method as string | null,
    reference: r.reference as string | null,
    amountPaise: Number(r.amount_paise),
    gstPaise: Number(r.gst_paise),
    receipt: r.receipt as string | null,
    invoice: r.invoice as string | null,
    correction: r.correction as boolean,
  }));
}

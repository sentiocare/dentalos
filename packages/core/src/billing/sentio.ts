import type { PaymentEvent, PaymentProvider } from "@dentalos/adapters";
import { actAsClinic, withPlatform, type Pool } from "@dentalos/db";
import { formatINR, type Paise } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { a4, pdfRupees } from "../pdf";
import { localDateOf } from "../time";
import { financialYear, gstIncluded } from "./ledger";
import { ownerContact, topupLink } from "./wallet";

/**
 * What a clinic pays Sentio (Build Prompt §4, PLAN §4.6): a one-time perpetual license, then usage from a
 * prepaid wallet topped up by a mandate (UPI Autopay / card / e-NACH) or a payment link. The mandate never
 * takes a fixed amount: each debit is a recharge announced at least 24 hours ahead (RBI e-mandate rules),
 * never above ₹15,000 (larger amounts need extra authentication, so they go by link).
 *
 * These functions work across clinics and run inside withPlatform (Sentio's own context).
 */
export interface SentioSeller {
  legalName: string;
  gstin: string | null;
  /** Two-letter state name or code, for CGST/SGST vs IGST. */
  state: string;
  address: string;
  sacLicense: string;
  sacUsage: string;
  gstRateBps: number;
}

export const DEFAULT_SELLER: SentioSeller = {
  legalName: "Sentio Care",
  gstin: null,
  state: "Jharkhand",
  address: "",
  sacLicense: "997331",
  sacUsage: "998439",
  gstRateBps: 1800,
};

/** RBI: automatic debits above this need additional authentication, so auto-recharges stay at or below it. */
export const MAX_AUTO_DEBIT_PAISE = 1_500_000;
/** A pre-debit notice must go at least this long before the debit. */
export const PRE_DEBIT_NOTICE_MS = 24 * 3600_000;

// ------------------------------------------------------------------------------------------ invoices

async function nextSentioNumber(client: PoolClient, fy: string): Promise<string> {
  await client.query("insert into sentio_invoice_sequences (fy) values ($1) on conflict do nothing", [fy]);
  const n = (
    await client.query(
      "update sentio_invoice_sequences set next_no = next_no + 1 where fy = $1 returning next_no - 1 as n",
      [fy],
    )
  ).rows[0].n as number;
  return `SNT/${fy}/${String(n).padStart(6, "0")}`;
}

/** Sentio's GST invoice for money received from a clinic; `totalPaise` includes GST. */
export async function issueSentioInvoice(
  client: PoolClient,
  seller: SentioSeller,
  input: {
    clinicId: string;
    kind: "license" | "recharge";
    description: string;
    totalPaise: number;
    at: Date;
  },
): Promise<{ id: string; number: string }> {
  const clinic = (
    await client.query(
      "select name, legal_name, gstin, address, city, state, timezone from clinics where id = $1",
      [input.clinicId],
    )
  ).rows[0];
  const gst = gstIncluded(input.totalPaise, seller.gstRateBps);
  const taxable = input.totalPaise - gst;
  const sameState = !!clinic.state && clinic.state.trim().toLowerCase() === seller.state.trim().toLowerCase();
  const cgst = sameState ? Math.floor(gst / 2) : 0;
  const fy = financialYear(input.at, "Asia/Kolkata");
  const number = await nextSentioNumber(client, fy);
  const { rows } = await client.query(
    `insert into sentio_invoices (clinic_id, number, fy, kind, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise,
                                  total_paise, place_of_supply, buyer, issued_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      input.clinicId,
      number,
      fy,
      input.kind,
      JSON.stringify([
        {
          description: input.description,
          sac: input.kind === "license" ? seller.sacLicense : seller.sacUsage,
          taxablePaise: taxable,
          gstRateBps: seller.gstRateBps,
          gstPaise: gst,
          totalPaise: input.totalPaise,
        },
      ]),
      taxable,
      cgst,
      sameState ? gst - cgst : 0,
      sameState ? 0 : gst,
      input.totalPaise,
      clinic.state ?? null,
      JSON.stringify({
        name: clinic.legal_name ?? clinic.name,
        gstin: clinic.gstin,
        address: [clinic.address, clinic.city, clinic.state].filter(Boolean).join(", "),
      }),
      input.at,
    ],
  );
  return { id: rows[0].id, number };
}

export async function renderSentioInvoicePdf(client: PoolClient, seller: SentioSeller, invoiceId: string) {
  const inv = (await client.query("select * from sentio_invoices where id = $1", [invoiceId])).rows[0];
  if (!inv) throw new DomainError("not_found", "Invoice not found");
  const w = await a4(`Tax invoice ${inv.number}`);
  w.text(seller.legalName, 50, 18, w.bold);
  w.down(18);
  if (seller.address) {
    w.text(seller.address.slice(0, 95), 50, 10, w.font, true);
    w.down(14);
  }
  if (seller.gstin) {
    w.text(`GSTIN: ${seller.gstin}`, 50, 10, w.font, true);
    w.down(14);
  }
  w.down(20);
  w.text("Tax invoice", 50, 15, w.bold);
  w.right(`No. ${inv.number}`, 545, 10);
  w.down(22);
  w.text(`Billed to: ${inv.buyer.name}`, 50);
  w.right(`Date: ${localDateOf(inv.issued_at, "Asia/Kolkata")}`, 545, 10);
  w.down(14);
  if (inv.buyer.gstin) {
    w.text(`GSTIN: ${inv.buyer.gstin}`, 50, 10);
    w.down(14);
  }
  if (inv.buyer.address) {
    w.text(String(inv.buyer.address).slice(0, 90), 50, 10, w.font, true);
    w.down(14);
  }
  w.down(16);
  w.text("Description", 50, 10, w.bold, true);
  w.text("SAC", 330, 10, w.bold, true);
  w.right("Taxable value", 545, 10, w.bold);
  w.down(6);
  w.line();
  w.down(16);
  for (const l of inv.lines as { description: string; sac: string; taxablePaise: number }[]) {
    w.text(l.description.slice(0, 50), 50, 10);
    w.text(l.sac, 330, 10);
    w.right(pdfRupees(l.taxablePaise), 545, 10);
    w.down(16);
  }
  w.y += 8;
  w.line();
  w.down(16);
  const tax: [string, number][] = Number(inv.igst_paise)
    ? [[`IGST ${seller.gstRateBps / 100}%`, Number(inv.igst_paise)]]
    : [
        [`CGST ${seller.gstRateBps / 200}%`, Number(inv.cgst_paise)],
        [`SGST ${seller.gstRateBps / 200}%`, Number(inv.sgst_paise)],
      ];
  for (const [label, amount] of tax) {
    w.text(label, 330, 10);
    w.right(pdfRupees(amount), 545, 10);
    w.down(14);
  }
  w.text("Total", 50, 12, w.bold);
  w.right(pdfRupees(Number(inv.total_paise)), 545, 12, w.bold);
  w.down(30);
  w.text(`Place of supply: ${inv.place_of_supply ?? "-"}`, 50, 9, w.font, true);
  return w.pdf.save();
}

// ------------------------------------------------------------------------------------------ license

/**
 * Sentio sells a clinic its license: a payment link for the price plus GST, sent to the owner. Paying it
 * (webhook) activates billing for the clinic and issues the invoice.
 */
export async function createLicense(
  client: PoolClient,
  deps: { payments: PaymentProvider; seller: SentioSeller },
  input: { clinicId: string; sku: string; pricePaise: number; updatesMonths?: number; now?: Date },
): Promise<{ licenseId: string; url: string; totalPaise: number }> {
  if (!Number.isSafeInteger(input.pricePaise) || input.pricePaise <= 0)
    throw new DomainError("invalid", "Enter the price");
  await actAsClinic(client, input.clinicId);
  const owner = await ownerContact(client);
  if (!owner?.phone) throw new DomainError("invalid", "The clinic has no owner phone number");
  const gst = Math.round((input.pricePaise * deps.seller.gstRateBps) / 10_000);
  const total = input.pricePaise + gst;
  const id = (await client.query("select gen_random_uuid() as id")).rows[0].id as string;
  const link = await deps.payments.createPaymentLink({
    amountPaise: total,
    description: `Sentio Dental OS license (${input.sku})`,
    customerPhone: owner.phone,
    referenceId: `license:${id}`,
    expiresAt: new Date((input.now ?? new Date()).getTime() + 30 * 86_400_000),
  });
  await client.query(
    `insert into licenses (id, clinic_id, sku, price_paise, gst_paise, status, provider_checkout_id, checkout_url, updates_months)
     values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
    [
      id,
      input.clinicId,
      input.sku,
      input.pricePaise,
      gst,
      link.providerLinkId,
      link.url,
      input.updatesMonths ?? 12,
    ],
  );
  return { licenseId: id, url: link.url, totalPaise: total };
}

// ------------------------------------------------------------------------------------------ mandates

/** The page where the owner authorises automatic recharges (a new registration replaces a failed one). */
export async function startMandateRegistration(
  client: PoolClient,
  deps: { payments: PaymentProvider },
  input: { clinicId: string; method: "upi_autopay" | "card" | "enach"; maxAmountPaise?: number },
): Promise<{ mandateId: string; url: string }> {
  await actAsClinic(client, input.clinicId);
  const owner = await ownerContact(client);
  if (!owner?.phone) throw new DomainError("invalid", "The clinic has no owner phone number");
  const max = Math.min(input.maxAmountPaise ?? MAX_AUTO_DEBIT_PAISE, MAX_AUTO_DEBIT_PAISE);
  const reg = await deps.payments.createMandateRegistration({
    referenceId: `mandate:${input.clinicId}`,
    maxAmountPaise: max,
    method: input.method,
    customer: { name: owner.name, phone: owner.phone, email: owner.email ?? undefined },
  });
  const { rows } = await client.query(
    `insert into mandates (clinic_id, provider, provider_customer_id, registration_url, payer_phone, payer_email, method,
                           max_amount_paise, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') returning id`,
    [
      input.clinicId,
      deps.payments.name,
      reg.providerCustomerId,
      reg.url,
      owner.phone,
      owner.email,
      input.method,
      max,
    ],
  );
  return { mandateId: rows[0].id, url: reg.url };
}

// ------------------------------------------------------------------------------------------ payments

export type SentioEventOutcome =
  | { outcome: "license_paid"; clinicId: string; invoiceId: string }
  | { outcome: "recharge_paid"; clinicId: string; invoiceId: string; creditedPaise: number }
  | { outcome: "recharge_failed"; clinicId: string; outboxIds: string[] }
  | { outcome: "mandate"; clinicId: string; status: string }
  | { outcome: "duplicate" | "ignored" };

/**
 * A payment event on Sentio's own account. Claimed and applied in one transaction: a retry after success
 * changes nothing; a failure part-way leaves the event for the gateway's retry.
 */
export async function ingestSentioPaymentEvent(
  pool: Pool,
  event: PaymentEvent,
  deps: { payments: PaymentProvider; seller: SentioSeller },
): Promise<SentioEventOutcome> {
  return withPlatform(pool, "system", async (c) => {
    const claim = async (clinicId: string | null) =>
      (
        await c.query("select app.claim_webhook_event('payments-sentio', $1, $2) as ok", [
          event.eventId,
          clinicId,
        ])
      ).rows[0].ok as boolean;

    if (event.type === "mandate_status") {
      const m = (
        await c.query("select * from mandates where provider = $1 and provider_customer_id = $2", [
          deps.payments.name,
          event.providerCustomerId,
        ])
      ).rows[0];
      if (!m) return { outcome: "ignored" };
      if (!(await claim(m.clinic_id))) return { outcome: "duplicate" };
      await c.query(
        `update mandates set provider_mandate_id = $2, status = $3, method = coalesce($4, method),
                max_amount_paise = coalesce($5, max_amount_paise), consecutive_failures = case when $3 = 'active' then 0 else consecutive_failures end
         where id = $1`,
        [m.id, event.providerMandateId, event.status, event.method ?? null, event.maxAmountPaise ?? null],
      );
      // One active mandate per clinic: a new one replaces the old.
      if (event.status === "active")
        await c.query(
          "update mandates set status = 'cancelled' where clinic_id = $1 and id <> $2 and status = 'active'",
          [m.clinic_id, m.id],
        );
      return { outcome: "mandate", clinicId: m.clinic_id, status: event.status };
    }

    const [kind, ref] = event.referenceId.split(":");
    if (kind === "license" && ref && event.type === "payment_captured") {
      const l = (await c.query("select * from licenses where id = $1 for update", [ref])).rows[0];
      if (!l) return { outcome: "ignored" };
      if (!(await claim(l.clinic_id)) || l.status === "paid") return { outcome: "duplicate" };
      const inv = await issueSentioInvoice(c, deps.seller, {
        clinicId: l.clinic_id,
        kind: "license",
        description: `Sentio Dental OS perpetual license (${l.sku})`,
        totalPaise: event.amountPaise,
        at: event.at,
      });
      // Updates and support run from the payment date for the months bought.
      await c.query(
        `update licenses set status = 'paid', purchased_at = $2, provider_payment_id = $3, invoice_id = $4,
                updates_support_until = ($5::date + make_interval(months => updates_months))::date where id = $1`,
        [l.id, event.at, event.providerPaymentId, inv.id, localDateOf(event.at, "Asia/Kolkata")],
      );
      // Billing starts with the license.
      await c.query("update wallets set enforced = true where clinic_id = $1", [l.clinic_id]);
      return { outcome: "license_paid", clinicId: l.clinic_id, invoiceId: inv.id };
    }

    // A recharge (by mandate or link), or the small authorisation payment when a mandate is set up.
    let recharge: { id: string; clinic_id: string; status: string; mandate_id: string | null } | undefined;
    if (kind === "recharge" && ref)
      recharge = (await c.query("select * from recharges where id = $1 for update", [ref])).rows[0];
    else if (kind === "mandate" && ref && event.type === "payment_captured") {
      if (!(await c.query("select 1 from clinics where id = $1", [ref])).rowCount)
        return { outcome: "ignored" };
      if (!(await claim(ref))) return { outcome: "duplicate" };
      recharge = (
        await c.query(
          `insert into recharges (clinic_id, via, amount_paise, status) values ($1, 'link', $2, 'link_sent')
           returning *`,
          [ref, event.amountPaise],
        )
      ).rows[0];
    }
    if (!recharge) return { outcome: "ignored" };
    if (kind === "recharge" && !(await claim(recharge.clinic_id))) return { outcome: "duplicate" };
    if (recharge.status === "paid") return { outcome: "duplicate" };

    if (event.type === "payment_failed") {
      await c.query("update recharges set status = 'failed', failure = $2 where id = $1", [
        recharge.id,
        event.reason,
      ]);
      const outboxIds: string[] = [];
      if (recharge.mandate_id) {
        // Three failures in a row: the mandate is treated as failed and the owner sets up a new one.
        await c.query(
          `update mandates set consecutive_failures = consecutive_failures + 1, last_failure = $2,
                  status = case when consecutive_failures + 1 >= 3 then 'failed' else status end
           where id = $1`,
          [recharge.mandate_id, event.reason],
        );
        // Tell the owner, with a link to pay instead.
        await actAsClinic(c, recharge.clinic_id);
        const owner = await ownerContact(c);
        const amount = Number(
          (await c.query("select amount_paise from recharges where id = $1", [recharge.id])).rows[0]
            .amount_paise,
        );
        if (owner?.phone) {
          const link = await topupLink(
            c,
            { payments: deps.payments },
            { amountPaise: amount, ownerPhone: owner.phone, now: event.at },
          );
          const clinic = (await c.query("select name from clinics where id = $1", [recharge.clinic_id]))
            .rows[0];
          const id = await enqueueMessage(c, {
            to: owner.phone,
            category: "critical",
            purpose: "billing_recharge_failed",
            dedupeKey: `recharge-failed:${recharge.id}`,
            payload: {
              kind: "template",
              purpose: "billing_recharge_failed",
              language: owner.language,
              params: [owner.name, clinic.name, formatINR(amount as Paise), link.url],
            },
          });
          if (id) outboxIds.push(id);
        }
      }
      return { outcome: "recharge_failed", clinicId: recharge.clinic_id, outboxIds };
    }
    if (event.type !== "payment_captured") return { outcome: "ignored" };

    // The amount paid includes GST; the wallet is credited with the value before tax.
    const inv = await issueSentioInvoice(c, deps.seller, {
      clinicId: recharge.clinic_id,
      kind: "recharge",
      description: "Sentio usage wallet recharge (prepaid usage credit)",
      totalPaise: event.amountPaise,
      at: event.at,
    });
    const gst = gstIncluded(event.amountPaise, deps.seller.gstRateBps);
    await c.query(
      `update recharges set status = 'paid', paid_at = $2, provider_payment_id = $3, invoice_id = $4, gst_paise = $5
       where id = $1`,
      [recharge.id, event.at, event.providerPaymentId, inv.id, gst],
    );
    const credit = event.amountPaise - gst;
    await c.query(
      `insert into wallet_credits (clinic_id, kind, amount_paise, recharge_id, note, at)
       values ($1, $2, $3, $4, $5, $6) on conflict (recharge_id) do nothing`,
      [
        recharge.clinic_id,
        recharge.mandate_id ? "recharge" : "topup",
        credit,
        recharge.id,
        `Invoice ${inv.number}`,
        event.at,
      ],
    );
    if (recharge.mandate_id)
      await c.query("update mandates set consecutive_failures = 0, last_failure = null where id = $1", [
        recharge.mandate_id,
      ]);
    return {
      outcome: "recharge_paid",
      clinicId: recharge.clinic_id,
      invoiceId: inv.id,
      creditedPaise: credit,
    };
  });
}

// ------------------------------------------------------------------------------------------ recharges

/** Average daily spend over the last 7 days (the burn rate used to forecast). */
export async function burnRatePerDay(client: PoolClient, clinicId: string, now: Date): Promise<number> {
  const s = Number(
    (
      await client.query(
        "select coalesce(sum(total_paise), 0)::bigint as s from usage_ledger where clinic_id = $1 and at > $2::timestamptz - interval '7 days' and at <= $2",
        [clinicId, now],
      )
    ).rows[0].s,
  );
  return s / 7;
}

/**
 * The auto-recharge forecast (PLAN §5.6). A debit can only happen 24 hours after its notice, so the notice
 * goes when the balance is forecast to reach the low level within the next 48 hours (or already has).
 * Returns the recharges announced, with the outbox ids of their notices.
 */
export async function planRecharges(
  pool: Pool,
  now: Date = new Date(),
): Promise<{ clinicId: string; rechargeId: string; amountPaise: number; outboxId: string | null }[]> {
  return withPlatform(pool, "job:recharge_forecast", async (c) => {
    const { rows } = await c.query(
      `select w.clinic_id, w.balance_paise, w.threshold_paise, w.recharge_amount_paise, m.id as mandate_id,
              m.max_amount_paise, m.method, c.name as clinic
       from wallets w join clinics c on c.id = w.clinic_id
       join mandates m on m.clinic_id = w.clinic_id and m.status = 'active' and m.provider_mandate_id is not null
       where w.enforced and w.auto_recharge
         and not exists (select 1 from recharges r where r.clinic_id = w.clinic_id and r.status in ('notified', 'debiting'))`,
    );
    const out: { clinicId: string; rechargeId: string; amountPaise: number; outboxId: string | null }[] = [];
    for (const w of rows) {
      const burn = await burnRatePerDay(c, w.clinic_id, now);
      const forecast = Number(w.balance_paise) - burn * 2;
      if (forecast > Number(w.threshold_paise)) continue;
      const amount = Math.min(
        Number(w.recharge_amount_paise),
        Number(w.max_amount_paise),
        MAX_AUTO_DEBIT_PAISE,
      );
      const debitAfter = new Date(now.getTime() + PRE_DEBIT_NOTICE_MS);
      const r = (
        await c.query(
          `insert into recharges (clinic_id, via, mandate_id, amount_paise, status, pre_debit_notified_at, debit_after, created_at)
           values ($1, 'mandate', $2, $3, 'notified', $4, $5, $4) returning id`,
          [w.clinic_id, w.mandate_id, amount, now, debitAfter],
        )
      ).rows[0];
      await actAsClinic(c, w.clinic_id);
      const owner = await ownerContact(c);
      let outboxId: string | null = null;
      if (owner?.phone) {
        const tz = "Asia/Kolkata";
        const method = { upi_autopay: "UPI Autopay", card: "card", enach: "bank mandate (e-NACH)" }[
          w.method as "upi_autopay" | "card" | "enach"
        ];
        outboxId = await enqueueMessage(c, {
          to: owner.phone,
          category: "critical",
          purpose: "billing_predebit",
          dedupeKey: `predebit:${r.id}`,
          payload: {
            kind: "template",
            purpose: "billing_predebit",
            language: owner.language,
            params: [
              owner.name,
              w.clinic,
              formatINR(amount as Paise),
              localDateOf(debitAfter, tz),
              method ?? "mandate",
            ],
          },
        });
      }
      out.push({ clinicId: w.clinic_id, rechargeId: r.id, amountPaise: amount, outboxId });
    }
    return out;
  });
}

/**
 * Debits the recharges whose notice period has passed. A recharge no longer needed (the owner topped up
 * meanwhile) is cancelled. The result arrives by webhook; a refused debit is handled like a failed payment.
 */
export async function debitDueRecharges(
  pool: Pool,
  deps: { payments: PaymentProvider; seller: SentioSeller },
  now: Date = new Date(),
): Promise<{ debited: number; cancelled: number; failed: number }> {
  const due = await withPlatform(
    pool,
    "job:recharge_debit",
    async (c) =>
      (
        await c.query(
          `select r.id, r.clinic_id, r.amount_paise, r.pre_debit_notified_at, m.provider_mandate_id, m.status as mandate_status,
                m.payer_phone, m.payer_email, w.balance_paise, w.threshold_paise
         from recharges r join mandates m on m.id = r.mandate_id join wallets w on w.clinic_id = r.clinic_id
         where r.status = 'notified' and r.debit_after <= $1`,
          [now],
        )
      ).rows,
  );
  const result = { debited: 0, cancelled: 0, failed: 0 };
  for (const r of due) {
    // Never debit without a notice at least 24 hours old (the database also refuses such a row).
    if (now.getTime() - r.pre_debit_notified_at.getTime() < PRE_DEBIT_NOTICE_MS) continue;
    if (
      r.mandate_status !== "active" ||
      Number(r.balance_paise) > Number(r.threshold_paise) + Number(r.amount_paise)
    ) {
      await withPlatform(pool, "job:recharge_debit", (c) =>
        c.query(
          "update recharges set status = 'cancelled', failure = $2 where id = $1 and status = 'notified'",
          [r.id, r.mandate_status !== "active" ? "mandate not active" : "not needed any more"],
        ),
      );
      result.cancelled++;
      continue;
    }
    // Mark first, so a crash after the gateway call can never debit twice.
    const claimed = await withPlatform(
      pool,
      "job:recharge_debit",
      async (c) =>
        (
          await c.query("update recharges set status = 'debiting' where id = $1 and status = 'notified'", [
            r.id,
          ])
        ).rowCount,
    );
    if (!claimed) continue;
    try {
      const charge = await deps.payments.chargeMandate({
        providerMandateId: r.provider_mandate_id,
        amountPaise: Number(r.amount_paise),
        referenceId: `recharge:${r.id}`,
        customer: { phone: r.payer_phone, email: r.payer_email ?? undefined },
      });
      await withPlatform(pool, "job:recharge_debit", (c) =>
        c.query("update recharges set provider_payment_id = $2 where id = $1", [
          r.id,
          charge.providerPaymentId,
        ]),
      );
      result.debited++;
    } catch (error) {
      result.failed++;
      await ingestSentioPaymentEvent(
        pool,
        {
          type: "payment_failed",
          eventId: `debit-refused:${r.id}`,
          providerPaymentId: `refused:${r.id}`,
          referenceId: `recharge:${r.id}`,
          reason: error instanceof Error ? error.message.slice(0, 200) : "debit refused",
          at: now,
        },
        deps,
      );
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------------ reconciliation

/** Which provider bills each kind of usage. */
export const PROVIDER_OF: Record<string, string> = {
  telephony_min: "telephony",
  stt_sec: "speech",
  tts_char: "speech",
  llm_input_token: "llm",
  llm_output_token: "llm",
  wa_utility: "whatsapp",
  wa_marketing: "whatsapp",
  wa_authentication: "whatsapp",
  sms_segment: "sms",
};

/**
 * Compares what our usage ledger says each provider should charge us with what the provider actually billed
 * (from its usage API or its invoice). Drift above 1% is flagged in the Sentio admin panel. Also checks
 * every wallet's cached balance against its ledger.
 */
export async function reconcile(
  pool: Pool,
  input: { periodStart: string; periodEnd: string; bills: Record<string, number | null> },
): Promise<
  {
    provider: string;
    ourPaise: number;
    billedPaise: number | null;
    driftPct: number | null;
    status: string;
  }[]
> {
  return withPlatform(pool, "job:reconcile", async (c) => {
    const ours = new Map<string, number>();
    const { rows } = await c.query(
      `select kind, sum(provider_cost_paise)::float8 as cost from usage_ledger
       where at >= $1::date::timestamptz and at < ($2::date + 1)::timestamptz group by kind`,
      [input.periodStart, input.periodEnd],
    );
    for (const r of rows) {
      const p = PROVIDER_OF[r.kind] ?? "other";
      ours.set(p, (ours.get(p) ?? 0) + r.cost);
    }
    const providers = [...new Set([...ours.keys(), ...Object.keys(input.bills)])].sort();
    const out = [];
    const save = (
      provider: string,
      our: number,
      billed: number | null,
      drift: number | null,
      status: string,
      detail = {},
    ) =>
      c.query(
        `insert into reconciliation_runs (period_start, period_end, provider, our_cost_paise, provider_cost_paise, drift_pct, status, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (period_start, period_end, provider) do update set our_cost_paise = excluded.our_cost_paise,
           provider_cost_paise = excluded.provider_cost_paise, drift_pct = excluded.drift_pct, status = excluded.status,
           detail = excluded.detail, created_at = now()`,
        [
          input.periodStart,
          input.periodEnd,
          provider,
          our,
          billed,
          drift === null ? null : Math.round(drift * 1000) / 1000,
          status,
          JSON.stringify(detail),
        ],
      );
    for (const provider of providers) {
      const our = Math.round((ours.get(provider) ?? 0) * 10_000) / 10_000;
      const billed = input.bills[provider] ?? null;
      const drift =
        billed === null
          ? null
          : billed === 0
            ? our === 0
              ? 0
              : 100
            : (Math.abs(our - billed) / billed) * 100;
      const status = billed === null ? "unavailable" : drift! <= 1 ? "ok" : "drift";
      await save(provider, our, billed, drift, status);
      out.push({ provider, ourPaise: our, billedPaise: billed, driftPct: drift, status });
    }
    // Every wallet's cached balance must equal its ledger (credits minus usage).
    const off = (
      await c.query(
        "select clinic_id, balance_paise, app.wallet_ledger_balance(clinic_id) as truth from wallets where balance_paise <> app.wallet_ledger_balance(clinic_id)",
      )
    ).rows;
    await save(
      "wallet_balances",
      off.length,
      0,
      off.length ? 100 : 0,
      off.length ? "drift" : "ok",
      off.length ? { off } : {},
    );
    out.push({
      provider: "wallet_balances",
      ourPaise: off.length,
      billedPaise: 0,
      driftPct: off.length ? 100 : 0,
      status: off.length ? "drift" : "ok",
    });
    return out;
  });
}

/** Sentio's invoice details from the environment (SENTIO_LEGAL_NAME, SENTIO_GSTIN, SENTIO_STATE, SENTIO_ADDRESS). */
export function sellerFromEnv(env: {
  SENTIO_LEGAL_NAME?: string;
  SENTIO_GSTIN?: string;
  SENTIO_STATE?: string;
  SENTIO_ADDRESS?: string;
}): SentioSeller {
  return {
    ...DEFAULT_SELLER,
    legalName: env.SENTIO_LEGAL_NAME || DEFAULT_SELLER.legalName,
    gstin: env.SENTIO_GSTIN || null,
    state: env.SENTIO_STATE || DEFAULT_SELLER.state,
    address: env.SENTIO_ADDRESS ?? "",
  };
}

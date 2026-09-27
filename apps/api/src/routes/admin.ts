import type { Adapters } from "@dentalos/adapters";
import {
  createLicense,
  enqueueMessage,
  ownerContact,
  reconcile,
  renderSentioInvoicePdf,
  scheduleSend,
  startMandateRegistration,
  type JobQueue,
  type SentioSeller,
} from "@dentalos/core";
import { actAsClinic, type Pool, type PoolClient } from "@dentalos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KINDS = [
  "telephony_min",
  "stt_sec",
  "tts_char",
  "llm_input_token",
  "llm_output_token",
  "wa_utility",
  "wa_marketing",
  "wa_authentication",
  "sms_segment",
] as const;

/**
 * The Sentio admin panel (PLAN Phase 5): every clinic's license, wallet, usage and margin, failed payments,
 * rate cards, reconciliation, and the health of each integration. Sentio staff only (platform_admins).
 */
export function adminRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; pool: Pool; adapters: Adapters; seller: SentioSeller; jobs: JobQueue },
) {
  app.get("/v1/admin/clinics", (request) =>
    deps.staff.inPlatform(request, async (c) => {
      const { rows } = await c.query(
        `select c.id, c.name, c.city, c.created_at,
                w.balance_paise, w.state, w.enforced, w.monthly_cap_paise,
                (select status from licenses l where l.clinic_id = c.id order by created_at desc limit 1) as license,
                (select status from mandates m where m.clinic_id = c.id order by created_at desc limit 1) as mandate,
                coalesce(u.usage_paise, 0)::bigint as usage_paise, coalesce(u.cost_paise, 0)::float8 as cost_paise,
                (select count(*)::int from recharges r where r.clinic_id = c.id and r.status = 'failed'
                   and r.created_at > now() - interval '30 days') as failed_payments
         from clinics c join wallets w on w.clinic_id = c.id
         left join lateral (
           select sum(total_paise) as usage_paise, sum(provider_cost_paise) as cost_paise from usage_ledger
           where clinic_id = c.id and at > now() - interval '30 days') u on true
         order by c.name`,
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        balancePaise: Number(r.balance_paise),
        state: r.state,
        enforced: r.enforced,
        license: r.license,
        mandate: r.mandate,
        usage30dPaise: Number(r.usage_paise),
        margin30dPaise: Math.round(Number(r.usage_paise) - r.cost_paise),
        failedPayments: r.failed_payments,
      }));
    }),
  );

  app.get("/v1/admin/clinics/:id", (request) =>
    deps.staff.inPlatform(request, async (c) => {
      const id = parse(idParams, request.params).id;
      const clinic = (
        await c.query("select id, name, city, state, gstin, phone from clinics where id = $1", [id])
      ).rows[0];
      if (!clinic) throw new HttpError(404, "not_found", "Clinic not found");
      const q = (sql: string) => c.query(sql, [id]).then((r) => r.rows);
      const [wallet, licenses, mandates, recharges, invoices, usage] = await Promise.all([
        q("select * from wallets where clinic_id = $1"),
        q(
          "select id, sku, price_paise, gst_paise, status, purchased_at, updates_support_until::text, checkout_url from licenses where clinic_id = $1 order by created_at desc",
        ),
        q(
          "select id, method, status, max_amount_paise, consecutive_failures, last_failure, created_at from mandates where clinic_id = $1 order by created_at desc",
        ),
        q(
          "select id, via, amount_paise, status, failure, debit_after, paid_at, created_at from recharges where clinic_id = $1 order by created_at desc limit 50",
        ),
        q(
          "select id, number, kind, total_paise, issued_at from sentio_invoices where clinic_id = $1 order by issued_at desc limit 50",
        ),
        q(`select kind, sum(quantity)::float8 as quantity, sum(total_paise)::bigint as total, sum(provider_cost_paise)::float8 as cost
           from usage_ledger where clinic_id = $1 and at > now() - interval '30 days' group by kind order by kind`),
      ]);
      return { clinic, wallet: wallet[0], licenses, mandates, recharges, invoices, usage };
    }),
  );

  // Sell the license: a payment link sent to the owner on WhatsApp (and returned to copy).
  app.post("/v1/admin/clinics/:id/license", async (request) => {
    const b = parse(
      z.object({
        sku: z.string().trim().min(2).max(40),
        pricePaise: z.number().int().min(100).max(100_000_000_00),
        updatesMonths: z.number().int().min(0).max(120).default(12),
      }),
      request.body,
    );
    const clinicId = parse(idParams, request.params).id;
    const res = await deps.staff.inPlatform(request, async (c) => {
      const lic = await createLicense(
        c,
        { payments: deps.adapters.payments, seller: deps.seller },
        { clinicId, ...b },
      );
      const outboxId = await sendLink(
        c,
        clinicId,
        "your Sentio Dental OS license",
        lic.url,
        `license:${lic.licenseId}`,
      );
      return { ...lic, outboxId };
    });
    if (res.outboxId) await scheduleSend(deps.jobs, clinicId, res.outboxId);
    return res;
  });

  app.post("/v1/admin/clinics/:id/mandate", async (request) => {
    const b = parse(z.object({ method: z.enum(["upi_autopay", "card", "enach"]) }), request.body);
    const clinicId = parse(idParams, request.params).id;
    const res = await deps.staff.inPlatform(request, async (c) => {
      const reg = await startMandateRegistration(
        c,
        { payments: deps.adapters.payments },
        { clinicId, method: b.method },
      );
      const outboxId = await sendLink(
        c,
        clinicId,
        "automatic recharge of your Sentio usage wallet",
        reg.url,
        `mandate:${reg.mandateId}`,
      );
      return { ...reg, outboxId };
    });
    if (res.outboxId) await scheduleSend(deps.jobs, clinicId, res.outboxId);
    return res;
  });

  // Switch billing on (or off for a pilot), and credit or debit the wallet by hand with a reason.
  app.post("/v1/admin/clinics/:id/wallet", (request) =>
    deps.staff.inPlatform(request, async (c) => {
      const b = parse(
        z.object({
          enforced: z.boolean().optional(),
          adjustmentPaise: z.number().int().min(-100_000_000).max(100_000_000).optional(),
          note: z.string().trim().min(3).max(200).optional(),
        }),
        request.body,
      );
      const clinicId = parse(idParams, request.params).id;
      if (b.adjustmentPaise) {
        if (!b.note) throw new HttpError(400, "invalid_input", "Write the reason for the adjustment");
        await c.query(
          "insert into wallet_credits (clinic_id, kind, amount_paise, note) values ($1, 'adjustment', $2, $3)",
          [clinicId, b.adjustmentPaise, b.note],
        );
      }
      if (b.enforced !== undefined)
        await c.query("update wallets set enforced = $2 where clinic_id = $1", [clinicId, b.enforced]);
      return (
        await c.query("select balance_paise, state, enforced from wallets where clinic_id = $1", [clinicId])
      ).rows[0];
    }),
  );

  app.get("/v1/admin/rates", (request) =>
    deps.staff.inPlatform(
      request,
      async (c) =>
        (
          await c.query(
            `select id, clinic_id, kind, unit, provider_cost_paise::float8, margin_pct::float8, margin_paise::float8, effective_from
           from rate_cards order by kind, clinic_id nulls first, effective_from desc`,
          )
        ).rows,
    ),
  );

  // Rates are never edited: a new rate takes effect from a date, so past usage keeps its price.
  app.post("/v1/admin/rates", (request) =>
    deps.staff.inPlatform(request, async (c) => {
      const b = parse(
        z.object({
          clinicId: z.string().uuid().nullable().default(null),
          kind: z.enum(KINDS),
          unit: z.string().trim().min(1).max(20),
          providerCostPaise: z.number().min(0).max(1_000_000),
          marginPct: z.number().min(0).max(1000).default(0),
          marginPaise: z.number().min(0).max(1_000_000).default(0),
          effectiveFrom: z.string().datetime({ offset: true }),
        }),
        request.body,
      );
      if (new Date(b.effectiveFrom).getTime() < Date.now() - 60_000)
        throw new HttpError(400, "invalid_input", "A new rate can only start now or later");
      const { rows } = await c.query(
        `insert into rate_cards (clinic_id, kind, unit, provider_cost_paise, margin_pct, margin_paise, effective_from)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [b.clinicId, b.kind, b.unit, b.providerCostPaise, b.marginPct, b.marginPaise, b.effectiveFrom],
      );
      return { id: rows[0].id };
    }),
  );

  app.get("/v1/admin/reconciliation", (request) =>
    deps.staff.inPlatform(
      request,
      async (c) =>
        (
          await c.query(
            `select period_start::text, period_end::text, provider, our_cost_paise::float8, provider_cost_paise::float8,
                  drift_pct::float8, status, detail, created_at
           from reconciliation_runs order by period_end desc, provider limit 200`,
          )
        ).rows,
    ),
  );

  // Provider bills entered from their invoices (or usage APIs), compared with our ledger.
  app.post("/v1/admin/reconciliation", async (request) => {
    await deps.staff.inPlatform(request, async () => null);
    const b = parse(
      z.object({
        periodStart: date,
        periodEnd: date,
        bills: z.record(z.string(), z.number().min(0).nullable()),
      }),
      request.body,
    );
    return reconcile(deps.pool, b);
  });

  // Integration health: each provider's own check, the worker and voice heartbeats, recent failures.
  app.get("/v1/admin/health", async (request) => {
    const beats = await deps.staff.inPlatform(request, async (c) => ({
      heartbeats: (
        await c.query(
          "select service, beat_at, extract(epoch from now() - beat_at)::int as age_sec from service_heartbeats",
        )
      ).rows,
      failedPayments: (
        await c.query(
          `select r.id, c.name as clinic, r.amount_paise, r.failure, r.created_at from recharges r join clinics c on c.id = r.clinic_id
           where r.status = 'failed' order by r.created_at desc limit 20`,
        )
      ).rows,
      failedMessages: Number(
        (
          await c.query(
            "select count(*) as n from outbox where status = 'failed' and created_at > now() - interval '1 day'",
          )
        ).rows[0].n,
      ),
    }));
    const providers = await Promise.all(
      (
        Object.entries(deps.adapters) as [
          string,
          { name: string; healthCheck: () => Promise<{ ok: boolean; detail?: string; latencyMs?: number }> },
        ][]
      ).map(async ([role, p]) => ({
        role,
        name: p.name,
        ...(await p.healthCheck().catch(() => ({ ok: false, detail: "check failed" }))),
      })),
    );
    return { providers, ...beats };
  });

  app.get("/v1/admin/invoices/:id/pdf", async (request, reply) => {
    const bytes = await deps.staff.inPlatform(request, (c) =>
      renderSentioInvoicePdf(c, deps.seller, parse(idParams, request.params).id),
    );
    return reply.type("application/pdf").send(Buffer.from(bytes));
  });
}

/** Sends a payment or registration link to the clinic owner on WhatsApp (from the clinic's number). */
async function sendLink(c: PoolClient, clinicId: string, what: string, url: string, key: string) {
  await actAsClinic(c, clinicId);
  const owner = await ownerContact(c);
  if (!owner?.phone) return null;
  return enqueueMessage(c, {
    to: owner.phone,
    category: "critical",
    purpose: "billing_link",
    dedupeKey: key,
    payload: {
      kind: "template",
      purpose: "billing_link",
      language: owner.language,
      params: [owner.name, what, url],
    },
  });
}

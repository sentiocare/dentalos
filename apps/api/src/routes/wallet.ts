import type { Adapters } from "@dentalos/adapters";
import {
  DEFAULT_SELLER,
  ingestSentioPaymentEvent,
  monthStart,
  ownerContact,
  renderSentioInvoicePdf,
  scheduleSend,
  startMandateRegistration,
  topupLink,
  updateWalletSettings,
  usageSummary,
  walletStatus,
  type JobQueue,
  type SentioSeller,
} from "@dentalos/core";
import { withPlatform, type Pool } from "@dentalos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

const paise = z.number().int();
const range = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * The clinic's side of Sentio billing (Build Prompt §4): the usage wallet, what it was spent on, top-ups, the
 * automatic-recharge mandate, and Sentio's invoices. Owner (settings permission) only.
 */
export function walletRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; pool: Pool; adapters: Adapters; seller: SentioSeller },
) {
  app.get("/v1/wallet", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const now = new Date();
      const status = await walletStatus(c, now);
      const tz = (await c.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
        .timezone;
      // One connection runs one query at a time, so these go one after another.
      const license = await c.query(
        "select sku, status, purchased_at, updates_support_until::text, checkout_url from licenses order by created_at desc limit 1",
      );
      const mandate = await c.query(
        "select method, status, max_amount_paise, last_failure, registration_url, created_at from mandates order by created_at desc limit 1",
      );
      const recharges = await c.query(
        `select id, via, amount_paise, gst_paise, status, debit_after, link_url, failure, paid_at, created_at
         from recharges order by created_at desc limit 20`,
      );
      const invoices = await c.query(
        "select id, number, kind, total_paise, issued_at from sentio_invoices order by issued_at desc limit 20",
      );
      const month = await usageSummary(c, { from: monthStart(now, tz), to: now });
      return {
        ...status,
        license: license.rows[0] ?? null,
        mandate: mandate.rows[0] ?? null,
        recharges: recharges.rows,
        invoices: invoices.rows,
        thisMonth: month,
      };
    }),
  );

  app.patch("/v1/wallet", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const b = parse(
        z.object({
          thresholdPaise: paise.min(0).max(10_000_000).optional(),
          rechargeAmountPaise: paise.min(10_000).max(1_500_000).optional(),
          monthlyCapPaise: paise.min(10_000).max(100_000_000).nullable().optional(),
          autoRecharge: z.boolean().optional(),
        }),
        request.body,
      );
      await updateWalletSettings(c, b);
      return { ok: true };
    }),
  );

  app.get("/v1/wallet/usage", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const q = parse(range, request.query);
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
      const summary = await usageSummary(c, { from, to });
      const recent = (
        await c.query(
          `select kind, quantity::float8 as quantity, total_paise, ref_type, ref, at from usage_ledger
           where at >= $1 and at < $2 order by at desc limit 200`,
          [from, to],
        )
      ).rows;
      return { ...summary, recent };
    }),
  );

  app.post("/v1/wallet/topup", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const b = parse(z.object({ amountPaise: paise.min(10_000).max(100_000_000) }), request.body);
      const owner = await ownerContact(c);
      if (!owner?.phone) throw new HttpError(400, "no_owner_phone", "The owner's phone number is missing");
      return topupLink(
        c,
        { payments: deps.adapters.payments },
        { amountPaise: b.amountPaise, ownerPhone: owner.phone },
      );
    }),
  );

  app.post("/v1/wallet/mandate", async (request) => {
    const staff = await deps.staff.resolve(request, "settings.manage");
    const b = parse(z.object({ method: z.enum(["upi_autopay", "card", "enach"]) }), request.body);
    // Mandates are written by Sentio's side; the owner only starts the registration.
    return withPlatform(deps.pool, `user:${staff.user.userId}`, (c) =>
      startMandateRegistration(
        c,
        { payments: deps.adapters.payments },
        { clinicId: staff.clinicId, method: b.method },
      ),
    );
  });

  app.get("/v1/wallet/invoices/:id/pdf", async (request, reply) => {
    const bytes = await deps.staff.inClinic(request, "settings.manage", async (c) => {
      const id = parse(idParams, request.params).id;
      if (!(await c.query("select 1 from sentio_invoices where id = $1", [id])).rowCount)
        throw new HttpError(404, "not_found", "Invoice not found");
      return renderSentioInvoicePdf(c, deps.seller, id);
    });
    return reply.type("application/pdf").send(Buffer.from(bytes));
  });
}

/** Payments on Sentio's own gateway account: licenses, recharges, mandates. */
export function sentioPaymentWebhook(
  app: FastifyInstance,
  deps: { pool: Pool; adapters: Adapters; jobs: JobQueue; seller?: SentioSeller },
) {
  app.post(
    "/webhooks/payments/sentio",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const webhook = {
        headers: request.headers as Record<string, string | undefined>,
        rawBody: String(request.body ?? ""),
      };
      const payments = deps.adapters.payments;
      if (!payments.verifyWebhook(webhook)) {
        request.log.warn("sentio payment webhook with a bad signature");
        return reply.code(401).send({ error: "bad_signature" });
      }
      for (const event of payments.parseWebhook(webhook)) {
        const result = await ingestSentioPaymentEvent(deps.pool, event, {
          payments,
          seller: deps.seller ?? DEFAULT_SELLER,
        });
        if (result.outcome === "recharge_failed")
          for (const id of result.outboxIds) await scheduleSend(deps.jobs, result.clinicId, id);
        request.log.info({ outcome: result.outcome }, "sentio payment event");
      }
      return reply.send({ ok: true });
    },
  );
}

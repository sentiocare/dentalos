import type { PaymentProvider, StorageProvider } from "@dentalos/adapters";
import {
  addAdjustment,
  addCharge,
  collections,
  connectPaymentAccount,
  createInvoice,
  createPatientPaymentLink,
  duesList,
  getPaymentAccount,
  ledgerExport,
  patientAccount,
  paymentAccountStatus,
  recordPayment,
  refundPayment,
  renderInvoicePdf,
  renderReceiptPdf,
  reverseEntry,
  scheduleSend,
  sendReceipt,
  type JobQueue,
} from "@dentalos/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

const uuid = z.string().uuid();
const paise = z.number().int().min(1).max(100_000_000_00);
const method = z.enum(["cash", "upi", "card", "bank"]);
/** Set by the dashboard for every change, so a retry after a network drop never books twice. */
const clientKey = z.string().min(8).max(80).optional();
const range = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

/**
 * The clinic's own money (Build Prompt §5.10): patient accounts, payments and receipts, invoices, payment
 * links, collections and dues. Rupee reports need the "see revenue" permission.
 */
export function billingRoutes(
  app: FastifyInstance,
  deps: {
    staff: StaffContextService;
    storage: StorageProvider;
    payments: PaymentProvider;
    jobs: JobQueue;
    channelKey: Buffer | null;
  },
) {
  const pdf = (bytes: Uint8Array, name: string) => ({ bytes, name });

  app.get("/v1/patients/:id/account", (request) =>
    deps.staff.inClinic(request, "billing.read", (c) =>
      patientAccount(c, parse(idParams, request.params).id),
    ),
  );

  app.post("/v1/patients/:id/charges", (request) =>
    deps.staff.inClinic(request, "billing.write", (c, staff) => {
      const b = parse(
        z.object({
          amountPaise: paise,
          description: z.string().trim().min(1).max(200),
          procedureTypeId: uuid.nullish(),
          appointmentId: uuid.nullish(),
          treatmentStepId: uuid.nullish(),
          clientKey,
        }),
        request.body,
      );
      return addCharge(c, {
        patientId: parse(idParams, request.params).id,
        ...b,
        dedupeKey: b.clientKey ? `client:${b.clientKey}` : undefined,
        userId: staff.user.userId,
      });
    }),
  );

  app.post("/v1/patients/:id/payments", (request) =>
    deps.staff
      .inClinic(request, "billing.write", async (c, staff) => {
        const b = parse(
          z.object({
            amountPaise: paise,
            method,
            reference: z.string().trim().max(100).nullish(),
            appointmentId: uuid.nullish(),
            sendReceipt: z.boolean().default(false),
            clientKey,
          }),
          request.body,
        );
        const paid = await recordPayment(c, {
          patientId: parse(idParams, request.params).id,
          amountPaise: b.amountPaise,
          method: b.method,
          reference: b.reference,
          appointmentId: b.appointmentId,
          dedupeKey: b.clientKey ? `client:${b.clientKey}` : undefined,
          userId: staff.user.userId,
        });
        const sent =
          b.sendReceipt && !paid.duplicate
            ? await sendReceipt(c, paid.receiptId, { storage: deps.storage })
            : null;
        return { staff, paid, outboxId: sent?.outboxId ?? null };
      })
      .then(async ({ staff, paid, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ...paid, receiptSent: !!outboxId };
      }),
  );

  app.post("/v1/patients/:id/adjustments", (request) =>
    deps.staff.inClinic(request, "billing.adjust", (c, staff) => {
      const b = parse(
        z.object({
          amountPaise: z.number().int().min(-100_000_000_00).max(100_000_000_00),
          description: z.string().trim().min(1).max(200),
        }),
        request.body,
      );
      return addAdjustment(c, {
        patientId: parse(idParams, request.params).id,
        ...b,
        userId: staff.user.userId,
      });
    }),
  );

  app.post("/v1/ledger/:id/reverse", (request) =>
    deps.staff.inClinic(request, "billing.adjust", (c, staff) => {
      const b = parse(z.object({ reason: z.string().trim().min(1).max(200) }), request.body);
      return reverseEntry(c, {
        entryId: parse(idParams, request.params).id,
        reason: b.reason,
        userId: staff.user.userId,
      });
    }),
  );

  app.post("/v1/ledger/:id/refund", (request) =>
    deps.staff.inClinic(request, "billing.adjust", (c, staff) => {
      const b = parse(
        z.object({
          amountPaise: paise,
          method: z.enum(["cash", "upi", "card", "bank", "gateway_link"]),
          reason: z.string().trim().min(1).max(150),
        }),
        request.body,
      );
      return refundPayment(c, {
        paymentId: parse(idParams, request.params).id,
        ...b,
        userId: staff.user.userId,
      });
    }),
  );

  app.post("/v1/patients/:id/invoices", (request) =>
    deps.staff.inClinic(request, "billing.write", (c, staff) => {
      const b = parse(z.object({ chargeIds: z.array(uuid).max(100).optional() }), request.body ?? {});
      return createInvoice(c, {
        patientId: parse(idParams, request.params).id,
        chargeIds: b.chargeIds,
        userId: staff.user.userId,
      });
    }),
  );

  const sendPdf = (kind: "receipt" | "invoice") => (request: FastifyRequest, reply: FastifyReply) =>
    deps.staff
      .inClinic(request, "billing.read", async (c) => {
        const id = parse(idParams, request.params).id;
        const row = (await c.query(`select number from ${kind}s where id = $1`, [id])).rows[0];
        if (!row)
          throw new HttpError(404, "not_found", `${kind === "receipt" ? "Receipt" : "Invoice"} not found`);
        return pdf(
          kind === "receipt" ? await renderReceiptPdf(c, id) : await renderInvoicePdf(c, id),
          row.number,
        );
      })
      .then(({ bytes, name }) =>
        reply
          .type("application/pdf")
          .header("content-disposition", `inline; filename="${String(name).replace(/[^\w.-]+/g, "-")}.pdf"`)
          .send(Buffer.from(bytes)),
      );
  app.get("/v1/receipts/:id/pdf", sendPdf("receipt"));
  app.get("/v1/invoices/:id/pdf", sendPdf("invoice"));

  app.post("/v1/receipts/:id/send", (request) =>
    deps.staff
      .inClinic(request, "billing.write", async (c, staff) => ({
        staff,
        ...(await sendReceipt(c, parse(idParams, request.params).id, { storage: deps.storage })),
      }))
      .then(async ({ staff, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ok: true, queued: !!outboxId };
      }),
  );

  app.post("/v1/patients/:id/payment-links", (request) =>
    deps.staff.inClinic(request, "billing.write", async (c) => {
      const b = parse(
        z.object({ amountPaise: paise, purpose: z.enum(["dues", "other"]).default("dues") }),
        request.body,
      );
      const account = await getPaymentAccount(c, deps.channelKey);
      return createPatientPaymentLink(
        c,
        { payments: deps.payments, account, requireAccount: deps.payments.name !== "fake-payments" },
        { patientId: parse(idParams, request.params).id, amountPaise: b.amountPaise, purpose: b.purpose },
      );
    }),
  );

  app.get("/v1/collections", (request) =>
    deps.staff.inClinic(request, "reports.revenue", (c) => {
      const q = parse(range, request.query);
      return collections(c, { from: new Date(q.from), to: new Date(q.to) });
    }),
  );

  app.get("/v1/dues", (request) => deps.staff.inClinic(request, "reports.revenue", (c) => duesList(c)));

  app.get("/v1/ledger/export", (request) =>
    deps.staff.inClinic(request, "reports.revenue", (c) => {
      const q = parse(range, request.query);
      return ledgerExport(c, { from: new Date(q.from), to: new Date(q.to) });
    }),
  );

  // The clinic's own Razorpay account, for patients paying the clinic.
  app.get("/v1/payments-account", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => paymentAccountStatus(c)),
  );

  app.put("/v1/payments-account", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c, staff) => {
      if (!deps.channelKey)
        throw new HttpError(
          503,
          "not_configured",
          "Saving gateway keys needs CHANNEL_SECRET_KEY on the server",
        );
      const b = parse(
        z.object({
          keyId: z.string().trim().min(8).max(60),
          keySecret: z.string().trim().min(8).max(100),
          webhookSecret: z.string().trim().min(8).max(100),
        }),
        request.body,
      );
      await connectPaymentAccount(c, deps.channelKey, b);
      return { ok: true, webhookPath: `/webhooks/payments/clinic/${staff.clinicId}` };
    }),
  );
}

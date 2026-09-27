import {
  advanceFollowups,
  createPatientPaymentLink,
  enqueueMessage,
  getPaymentAccount,
  sendReceipt,
  expireEstimates,
  planFollowups,
  scheduleSend,
} from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { formatINR, type Paise } from "@dentalos/shared";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";
import { queueFromHelpers } from "./outbox";

/**
 * Every few minutes, for each clinic: start follow-ups for new subjects, run the steps that are due, queue
 * the AI calls they asked for, and expire old estimates.
 */
export function makeFollowupsTask(deps: Pick<WorkerDeps, "pool" | "logger" | "adapters" | "channelKey">) {
  return async (_payload: unknown, helpers: JobHelpers) => {
    const queue = queueFromHelpers(helpers);
    const { rows } = await deps.pool.query("select id from clinics");
    for (const { id: clinicId } of rows) {
      const result = await withClinic(
        deps.pool,
        { clinicId, actor: "job:followups", role: "system" },
        async (c) => {
          await expireEstimates(c);
          const started = await planFollowups(c, new Date(), { jobs: queue });
          const stepped = await advanceFollowups(c, new Date());
          const due = (
            await c.query(
              "select id from outbox where status = 'pending' and not_before <= now() and purpose like 'followup_%' limit 200",
            )
          ).rows;
          return { started, stepped, due };
        },
      );
      // Dues reminders carry a payment link on the clinic's own gateway account; the next run sends them.
      for (const l of result.stepped.links) {
        try {
          await withClinic(deps.pool, { clinicId, actor: "job:followups", role: "system" }, async (c) => {
            const account = await getPaymentAccount(c, deps.channelKey);
            if (!account && deps.adapters.payments.name !== "fake-payments") return;
            await createPatientPaymentLink(
              c,
              { payments: deps.adapters.payments, account },
              { patientId: l.patientId, amountPaise: l.amountPaise, purpose: "dues" },
            );
          });
        } catch (error) {
          deps.logger.warn({ clinicId, err: error }, "dues payment link not created");
        }
      }
      for (const call of result.stepped.calls)
        await queue.add("place_call", { clinicId, ...call }, { jobKey: `call:${call.runId}:${call.step}` });
      for (const r of result.due) await scheduleSend(queue, clinicId, r.id);
      const s = result.stepped;
      if (s.messages || s.calls.length || s.tasks || s.stopped)
        deps.logger.info(
          { clinicId, messages: s.messages, calls: s.calls.length, tasks: s.tasks, stopped: s.stopped },
          "follow-ups run",
        );
    }
  };
}

/** A payment link for an appointment's advance, sent on WhatsApp; the payment webhook marks it paid. */
export function makeRequestDepositTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "channelKey">) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId, appointmentId } = payload as { clinicId: string; appointmentId: string };
    const ctx = { clinicId, actor: "job:request_deposit" as const, role: "system" as const };
    const a = await withClinic(
      deps.pool,
      ctx,
      async (c) =>
        (
          await c.query(
            `select a.id, a.deposit_paise, a.deposit_status, a.deposit_link, p.id as patient_id, p.name, p.phone, p.language_pref,
                  cl.name as clinic, cl.default_language
           from appointments a join patients p on p.id = a.patient_id join clinics cl on cl.id = a.clinic_id where a.id = $1`,
            [appointmentId],
          )
        ).rows[0],
    );
    if (!a || a.deposit_status !== "requested" || !a.phone || !a.deposit_paise) return;
    // The link is on the clinic's own gateway account; the payment webhook marks the advance paid.
    const link =
      a.deposit_link ??
      (await withClinic(deps.pool, ctx, async (c) => {
        const account = await getPaymentAccount(c, deps.channelKey);
        if (!account && deps.adapters.payments.name !== "fake-payments") return null;
        return (
          await createPatientPaymentLink(
            c,
            { payments: deps.adapters.payments, account },
            {
              patientId: a.patient_id,
              amountPaise: Number(a.deposit_paise),
              purpose: "deposit",
              appointmentId: a.id,
            },
          )
        ).url;
      }));
    if (!link) return; // No gateway connected: the clinic collects the advance at the desk.
    const outboxId = await withClinic(deps.pool, ctx, async (c) => {
      await c.query("update appointments set deposit_link = $2 where id = $1", [a.id, link]);
      const language =
        a.language_pref === "en" || (!a.language_pref && a.default_language === "en") ? "en" : "hi";
      return enqueueMessage(c, {
        to: a.phone,
        category: "transactional",
        purpose: "deposit_request",
        patientId: a.patient_id,
        appointmentId: a.id,
        dedupeKey: `deposit:${a.id}`,
        payload: {
          kind: "template",
          purpose: "deposit_request",
          language,
          params: [a.name, a.clinic, formatINR(Number(a.deposit_paise) as Paise), link],
        },
      });
    });
    if (outboxId) await scheduleSend(queueFromHelpers(helpers), clinicId, outboxId);
  };
}

/** Sends the receipt for a payment made online (PDF link on WhatsApp). */
export function makeSendReceiptTask(deps: Pick<WorkerDeps, "pool" | "adapters">) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId, receiptId } = payload as { clinicId: string; receiptId: string };
    const { outboxId } = await withClinic(
      deps.pool,
      { clinicId, actor: "job:send_receipt", role: "system" },
      (c) => sendReceipt(c, receiptId, { storage: deps.adapters.storage }),
    );
    if (outboxId) await scheduleSend(queueFromHelpers(helpers), clinicId, outboxId);
  };
}

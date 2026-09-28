import {
  advanceFollowups,
  createLead,
  leadFromForm,
  metaPageToken,
  scheduleSend,
  sendLeadSignals,
} from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import type { JobQueue } from "@dentalos/core";
import type { WorkerDeps } from "../worker";
import { queueFromHelpers } from "./outbox";

/**
 * Speed to lead: runs the due follow-up steps for one clinic right away (not at the next 5-minute tick), so
 * a new lead's first WhatsApp goes within seconds, and sends what was queued.
 */
export async function kickoffLeads(pool: Pool, queue: JobQueue, clinicId: string, now = new Date()) {
  const ids = await withClinic(pool, { clinicId, actor: "job:leads", role: "system" }, async (c) => {
    await advanceFollowups(c, now, 50);
    return (
      await c.query(
        "select id from outbox where status = 'pending' and not_before <= $1 and (purpose like 'followup_%' or purpose = 'staff_lead_alert') limit 100",
        [now],
      )
    ).rows.map((r) => r.id as string);
  });
  for (const id of ids) await scheduleSend(queue, clinicId, id);
}

/** A Facebook/Instagram form lead: fetch the answers with the clinic's Page token, record it, message it. */
export function makeFetchLeadTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "channelKey" | "logger">) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId, leadgenId } = payload as { clinicId: string; leadgenId: string };
    const ctx = { clinicId, actor: "job:fetch_lead" as const, role: "system" as const };
    const token = await withClinic(deps.pool, ctx, (c) => metaPageToken(c, deps.channelKey));
    if (!token) {
      deps.logger.warn({ clinicId }, "lead arrived but the clinic's Page token is missing");
      return;
    }
    // A failure here (Meta busy) throws and the job is retried with backoff.
    const details = await deps.adapters.leads.fetchLead(token, leadgenId);
    const form = leadFromForm(details);
    if (!form.phone) {
      deps.logger.warn({ clinicId }, "lead form without a phone number");
      return;
    }
    await withClinic(deps.pool, ctx, (c) =>
      createLead(c, {
        source: "meta_form",
        externalId: leadgenId,
        phone: form.phone!,
        name: form.name,
        email: form.email,
        campaign: details.campaignName ?? null,
        ad: details.adName ?? null,
        need: form.need,
        timing: form.timing,
        answers: form.answers,
      }),
    );
    await kickoffLeads(deps.pool, queueFromHelpers(helpers), clinicId);
  };
}

/** A lead added by staff: its first WhatsApp goes now. */
export function makeLeadKickoffTask(deps: Pick<WorkerDeps, "pool">) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId } = payload as { clinicId: string };
    await kickoffLeads(deps.pool, queueFromHelpers(helpers), clinicId);
  };
}

/**
 * Every 15 minutes: tells Meta which ad leads were qualified, booked, came in and paid, for each clinic with a
 * connected dataset (Meta asks for at least daily uploads; sooner means the ads learn sooner).
 */
export function makeLeadSignalsTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "channelKey" | "logger">) {
  return async () => {
    const { rows } = await deps.pool.query(
      "select distinct clinic_id from clinic_channels where kind = 'meta_page' and active",
    );
    for (const { clinic_id: clinicId } of rows) {
      try {
        const result = await withClinic(
          deps.pool,
          { clinicId, actor: "job:lead_signals", role: "system" },
          (c) => sendLeadSignals(c, { key: deps.channelKey, leads: deps.adapters.leads }),
        );
        if (result.failed) deps.logger.warn({ clinicId, ...result }, "Meta did not accept lead events");
      } catch (error) {
        deps.logger.warn({ clinicId, err: error }, "lead signals failed");
      }
    }
  };
}

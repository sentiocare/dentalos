import { createHash } from "node:crypto";
import type { ConversionEvent, LeadAdsProvider } from "@dentalos/adapters";
import type { PoolClient } from "pg";
import { metaDataset } from "./channels";

/**
 * Closing the loop with Meta (the Conversions API for leads). Meta's ads learn from whatever the clinic tells
 * them: sent only form fills, they find more people who fill forms. Sent which leads were qualified, booked,
 * came in and paid, they find people like those. This is the single biggest lever on cost per patient.
 *
 * Only leads that came from Meta are sent: form leads with Meta's lead id, Click-to-WhatsApp leads with the ad's
 * click id. Nothing about treatment is sent, only the stage, the time, a hashed phone and (for "won") the amount.
 */

/** Stage → event name. Form leads use our own stage names (the clinic picks one to optimise for in Events
 * Manager); WhatsApp-ad leads use Meta's standard events. "visited" has no standard event, so it is form-only. */
const WHATSAPP_EVENT: Record<string, string | null> = {
  qualified: "Lead",
  booked: "Schedule",
  visited: null,
  won: "Purchase",
};

/** Meta accepts events up to 7 days old; older ones are skipped (and say so). */
const MAX_AGE_MS = 7 * 24 * 3600_000;

export function hashPhone(e164: string): string {
  return createHash("sha256").update(e164.replace(/\D/g, "")).digest("hex");
}

/** Records each stage a Meta lead reached (from its timeline), once. Safe to repeat. */
export async function queueLeadSignals(client: PoolClient): Promise<number> {
  const { rowCount } = await client.query(
    `insert into lead_meta_events (clinic_id, lead_id, stage, occurred_at)
     select a.clinic_id, a.lead_id, a.kind, min(a.at)
     from lead_activities a join leads l on l.id = a.lead_id
     where l.source in ('meta_form', 'ctwa') and l.external_id is not null
       and a.kind in ('qualified', 'booked', 'visited', 'won')
     group by a.clinic_id, a.lead_id, a.kind
     on conflict (lead_id, stage) do nothing`,
  );
  return rowCount ?? 0;
}

/**
 * Sends the queued events to the clinic's dataset. Without a connected dataset nothing is sent (the events
 * wait, so connecting later still sends the last week's). A failure is recorded and retried next time, up to
 * 5 attempts.
 */
export async function sendLeadSignals(
  client: PoolClient,
  deps: { key: Buffer | null; leads: LeadAdsProvider; now?: Date },
): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = deps.now ?? new Date();
  const result = { sent: 0, skipped: 0, failed: 0 };
  await queueLeadSignals(client);
  const dataset = await metaDataset(client, deps.key);
  if (!dataset) return result;

  const { rows } = await client.query(
    `select e.id, e.lead_id, e.stage, e.occurred_at, l.source, l.external_id, l.phone, l.won_value_paise
     from lead_meta_events e join leads l on l.id = e.lead_id
     where e.status in ('pending', 'failed') and e.attempts < 5
     order by e.occurred_at limit 500`,
  );
  const skip = async (id: string, why: string) => {
    await client.query("update lead_meta_events set status = 'skipped', error = $2 where id = $1", [id, why]);
    result.skipped++;
  };
  const events: { id: string; event: ConversionEvent }[] = [];
  for (const r of rows) {
    if (now.getTime() - r.occurred_at.getTime() > MAX_AGE_MS) {
      await skip(r.id, "older than 7 days");
      continue;
    }
    const base = {
      eventTime: r.occurred_at as Date,
      eventId: `${r.lead_id}:${r.stage}`,
      hashedPhone: hashPhone(r.phone),
      ...(r.stage === "won" && Number(r.won_value_paise) > 0
        ? { valuePaise: Number(r.won_value_paise) }
        : {}),
    };
    if (r.source === "meta_form") {
      events.push({ id: r.id, event: { ...base, kind: "crm", eventName: r.stage, leadId: r.external_id } });
    } else {
      const name = WHATSAPP_EVENT[r.stage];
      // Without the ad's click id (we kept the message id instead) the chat can't be matched to the ad.
      if (!name || r.external_id.startsWith("wamid.")) {
        await skip(r.id, name ? "no ad click id" : "no standard event for this stage");
        continue;
      }
      events.push({
        id: r.id,
        event: {
          ...base,
          kind: "whatsapp",
          eventName: name,
          ctwaClid: r.external_id,
          pageId: dataset.pageId,
        },
      });
    }
  }
  if (!events.length) return result;

  const ids = events.map((e) => e.id);
  try {
    await deps.leads.sendConversions({
      datasetId: dataset.datasetId,
      accessToken: dataset.accessToken,
      events: events.map((e) => e.event),
    });
    await client.query(
      "update lead_meta_events set status = 'sent', sent_at = $2, attempts = attempts + 1, error = null where id = any($1)",
      [ids, now],
    );
    result.sent = ids.length;
  } catch (error) {
    await client.query(
      "update lead_meta_events set status = 'failed', attempts = attempts + 1, error = $2 where id = any($1)",
      [ids, error instanceof Error ? error.message.slice(0, 300) : "failed"],
    );
    result.failed = ids.length;
  }
  return result;
}

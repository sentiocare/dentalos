import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";

/**
 * Reactivation campaigns (Build Prompt §7.7): promotional, so they need the owner's approval, go only to
 * patients who gave marketing consent and have not opted out, respect promotional hours (the outbox waits),
 * and the clinic's own words must stay factual (no superlatives, urgency, discounts on treatment, or claims).
 */
const NOT_ALLOWED: [RegExp, string][] = [
  [
    /\b(best|no\.?\s*1|number one|top|cheapest|lowest price|guarantee[ds]?|100\s*%|painless|pain[- ]free|permanent)\b/i,
    "superlatives or guarantees",
  ],
  [
    /\b(hurry|last chance|today only|limited (time|period|offer)|act now|expires? (today|soon))\b/i,
    "urgency",
  ],
  [
    /\b(free|discount|% off|offer|sale)\b.*\b(rct|root canal|implant|extraction|surgery|treatment)\b|\b(rct|root canal|implant|extraction|surgery|treatment)\b.*\b(free|discount|% off)\b/i,
    "discounts on treatment",
  ],
  [
    /\b(cure|cures|heal|heals|prevents? (cancer|disease)|safe for everyone|no side effects?)\b/i,
    "medical claims",
  ],
  [/(सबसे अच्छा|गारंटी|मुफ़्त इलाज|मुफ्त इलाज|दर्द रहित)/, "superlatives or guarantees"],
];

export function checkPromotionalText(text: string): string[] {
  return [...new Set(NOT_ALLOWED.filter(([re]) => re.test(text)).map(([, why]) => why))];
}

export interface Audience {
  eligible: { patientId: string; name: string; phone: string; language: "en" | "hi" }[];
  noConsent: number;
  optedOut: number;
}

/** Patients whose last visit is older than `inactiveMonths`, with no upcoming appointment. */
export async function campaignAudience(
  client: PoolClient,
  inactiveMonths: number,
  now: Date = new Date(),
): Promise<Audience> {
  const { rows } = await client.query(
    `with last_visit as (
       select patient_id, max(starts_at) as at from appointments where status = 'completed' group by patient_id
     )
     select p.id, p.name, p.phone, p.language_pref, c.default_language,
            (select granted from consents k where k.phone = p.phone and k.purpose = 'marketing' order by k.at desc limit 1) as consent,
            exists (select 1 from opt_outs o where o.phone = p.phone and o.revoked_at is null
                    and o.channel in ('all', 'whatsapp') and o.category in ('all', 'promotional')) as opted_out
     from patients p join last_visit lv on lv.patient_id = p.id join clinics c on c.id = p.clinic_id
     where p.deleted_at is null and p.phone is not null
       and lv.at < $1::timestamptz - make_interval(months => $2)
       and not exists (select 1 from appointments a where a.patient_id = p.id and a.starts_at > $1 and a.status in ('booked', 'confirmed'))
     order by p.name`,
    [now, inactiveMonths],
  );
  const out: Audience = { eligible: [], noConsent: 0, optedOut: 0 };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.opted_out) out.optedOut++;
    else if (r.consent !== true) out.noConsent++;
    // One message per phone number, even when a family shares it.
    else if (!seen.has(r.phone)) {
      seen.add(r.phone);
      const pref = r.language_pref ?? r.default_language;
      out.eligible.push({
        patientId: r.id,
        name: r.name,
        phone: r.phone,
        language: pref === "en" ? "en" : "hi",
      });
    }
  }
  return out;
}

export async function createCampaign(
  client: PoolClient,
  input: { name: string; inactiveMonths: number; offerText: string; createdBy?: string | null },
): Promise<{ id: string; problems: string[] }> {
  const problems = checkPromotionalText(input.offerText);
  const { rows } = await client.query(
    `insert into campaigns (clinic_id, name, audience, offer_text, created_by)
     values (app.current_clinic_id(), $1, $2, $3, $4) returning id`,
    [
      input.name,
      JSON.stringify({ inactiveMonths: input.inactiveMonths }),
      input.offerText,
      input.createdBy ?? null,
    ],
  );
  return { id: rows[0].id, problems };
}

async function load(client: PoolClient, id: string) {
  const c = (await client.query("select * from campaigns where id = $1 for update", [id])).rows[0];
  if (!c) throw new DomainError("not_found", "Campaign not found");
  return c;
}

/** Staff send a draft to the owner. */
export async function submitCampaign(client: PoolClient, id: string) {
  const c = await load(client, id);
  if (c.status !== "draft") throw new DomainError("invalid", "Only a draft can be sent for approval");
  const problems = checkPromotionalText(c.offer_text ?? "");
  if (problems.length) throw new DomainError("invalid", `Please change the message: ${problems.join(", ")}`);
  await client.query("update campaigns set status = 'awaiting_owner' where id = $1", [id]);
}

/** Only the clinic owner can approve (checked by the caller's permission). */
export async function approveCampaign(client: PoolClient, id: string, ownerUserId: string) {
  const c = await load(client, id);
  if (c.status !== "awaiting_owner")
    throw new DomainError("invalid", "This campaign is not waiting for approval");
  await client.query(
    "update campaigns set status = 'approved', owner_approved_by = $2, owner_approved_at = now() where id = $1",
    [id, ownerUserId],
  );
}

export async function cancelCampaign(client: PoolClient, id: string) {
  const c = await load(client, id);
  if (["done", "cancelled"].includes(c.status))
    throw new DomainError("invalid", "This campaign has finished");
  await client.query("update campaigns set status = 'cancelled' where id = $1", [id]);
  await client.query(
    "update outbox set status = 'cancelled', last_error = 'campaign_cancelled' where status = 'pending' and dedupe_key like $1",
    [`campaign:${id}:%`],
  );
}

/**
 * Queues the messages of an approved campaign. The outbox holds them until promotional hours and checks
 * consent and opt-outs again at send time.
 */
export async function runCampaign(client: PoolClient, id: string, now: Date = new Date()) {
  const c = await load(client, id);
  if (c.status !== "approved") throw new DomainError("invalid", "The owner must approve the campaign first");
  const clinic = (await client.query("select name from clinics where id = app.current_clinic_id()")).rows[0];
  const audience = await campaignAudience(client, Number(c.audience?.inactiveMonths ?? 12), now);
  let queued = 0;
  for (const r of audience.eligible) {
    const outboxId = await enqueueMessage(client, {
      to: r.phone,
      category: "promotional",
      purpose: "campaign_reactivation",
      patientId: r.patientId,
      dedupeKey: `campaign:${id}:${r.patientId}`,
      payload: {
        kind: "template",
        purpose: "reactivation",
        language: r.language,
        params: [r.name, clinic.name, c.offer_text ?? ""],
        buttonPayloads: ["recall_book:campaign"],
      },
    });
    await client.query(
      `insert into campaign_recipients (clinic_id, campaign_id, patient_id, phone, outbox_id)
       values (app.current_clinic_id(), $1, $2, $3, $4) on conflict (campaign_id, patient_id) do nothing`,
      [id, r.patientId, r.phone, outboxId],
    );
    if (outboxId) queued++;
  }
  const stats = { queued, noConsent: audience.noConsent, optedOut: audience.optedOut };
  await client.query("update campaigns set status = 'done', stats = $2 where id = $1", [
    id,
    JSON.stringify(stats),
  ]);
  return stats;
}

export async function listCampaigns(client: PoolClient) {
  return (
    await client.query(
      `select c.id, c.name, c.audience, c.offer_text, c.status, c.stats, c.created_at, c.owner_approved_at, u.name as approved_by
       from campaigns c left join users u on u.id = c.owner_approved_by order by c.created_at desc limit 50`,
    )
  ).rows;
}

/** Staff record a patient's answer about offers (e.g. asked at the desk). Append-only evidence. */
export async function recordMarketingConsent(
  client: PoolClient,
  input: { phone: string; patientId: string; granted: boolean; via: string; userId?: string | null },
) {
  await client.query(
    `insert into consents (clinic_id, phone, patient_id, purpose, channel, granted, notice_version, captured_via)
     values (app.current_clinic_id(), $1, $2, 'marketing', 'in_person', $3, 'marketing-v1', $4)`,
    [input.phone, input.patientId, input.granted, input.via],
  );
}

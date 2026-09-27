import type { LeadDetails } from "@dentalos/adapters";
import { normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { addDays, localDateOf, localMinutesOf, weekdayOf, zonedInstant } from "../time";

/**
 * Leads (Build Prompt §5.8; PLAN Phase 6). How it works, following what converts paid leads best:
 *
 * 1. Speed: a new lead gets a WhatsApp from the clinic within seconds (the follow-up engine's first step),
 *    with buttons to book a visit, ask a question or ask for a call.
 * 2. The assistant qualifies with two tap-answers (what they need, when) and books a consultation itself.
 *    It never negotiates price and never gives medical advice; those stay with people.
 * 3. People make the final call: hot leads (pain, soon) and high-value ones (implants, braces, smile work)
 *    get a "call now" task for staff within 15 minutes of clinic hours, with everything the lead said.
 *    AI voice calls to leads stay off: they would be promotional calls (TRAI; ASSUMPTIONS A-10).
 * 4. Leads that don't book are nudged twice over a few days, then handed to staff, then closed.
 * 5. Every stage is recorded (new → contacted → engaged → qualified → booked → visited → won), so the owner
 *    sees what each campaign produced in patients and rupees.
 */
export type LeadSource =
  "meta_form" | "ctwa" | "website" | "practo" | "justdial" | "walk_in" | "phone" | "referral" | "other";
/** "major": braces, implants or smile work, when the lead picked that button without saying which. */
export type LeadNeed = "pain" | "implant" | "braces" | "rct" | "cleaning" | "cosmetic" | "major" | "other";
export type LeadTiming = "now" | "week" | "month" | "exploring";
export type LeadStage =
  "new" | "contacted" | "engaged" | "qualified" | "booked" | "visited" | "won" | "lost" | "unresponsive";

/** Treatments worth a person's call even without urgency (larger plans, more questions, more to lose). */
export const HIGH_VALUE: LeadNeed[] = ["implant", "braces", "cosmetic", "major"];
const OPEN: LeadStage[] = ["new", "contacted", "engaged", "qualified"];

const NEED_WORDS: [LeadNeed, RegExp][] = [
  ["pain", /pain|dard|ache|swell|sujan|bleed|broken|toot|emergency|दर्द|सूजन/i],
  ["implant", /implant|missing|fixed teeth|dentures?|बत्तीसी|इम्प्लांट/i],
  ["braces", /brace|aligner|ortho|straight|crooked|gap|टेढ़े|ब्रेस/i],
  ["rct", /root ?canal|\brct\b/i],
  ["cosmetic", /whiten|smile|veneer|cosmetic|makeover|सफ़ेद/i],
  ["cleaning", /clean|scal|check.?up|checkup|polish|सफ़ाई|जाँच/i],
];

/** What the lead wants, from their words; null when nothing recognisable was said (then we ask). */
export function needFromText(text: string | null | undefined): LeadNeed | null {
  if (!text?.trim()) return null;
  for (const [need, re] of NEED_WORDS) if (re.test(text)) return need;
  return null;
}

export function timingFromText(text: string | null | undefined): LeadTiming | null {
  if (!text?.trim()) return null;
  if (/today|now|urgent|asap|abhi|aaj|turant/i.test(text)) return "now";
  if (/week|hafte|days?/i.test(text)) return "week";
  if (/month|mahin/i.test(text)) return "month";
  if (/explor|just|info|later|not sure|pata/i.test(text)) return "exploring";
  return null;
}

/** Hot: pain, or wants to come within a week; also high-value unless only exploring. Cold: only exploring. */
export function scoreLead(need: LeadNeed | null, timing: LeadTiming | null): "hot" | "warm" | "cold" {
  if (need === "pain" || timing === "now" || timing === "week") return "hot";
  if (timing === "exploring") return "cold";
  if (need && HIGH_VALUE.includes(need)) return "hot";
  return "warm";
}

/** A Meta lead form's answers in our terms. The form's own questions are kept as asked. */
export function leadFromForm(details: LeadDetails) {
  const get = (...names: string[]) =>
    details.fields.find((f) => names.includes(f.name.toLowerCase()))?.values[0]?.trim() || null;
  const first = get("first_name");
  const last = get("last_name");
  const answers: Record<string, string> = {};
  for (const f of details.fields) answers[f.name] = f.values.join(", ");
  const custom = details.fields.filter(
    (f) =>
      !["full_name", "first_name", "last_name", "phone_number", "email", "city", "zip_code"].includes(f.name),
  );
  const customText = custom.map((f) => `${f.name} ${f.values.join(" ")}`).join(" ");
  const whenField = custom.find((f) => /when|kab|time/i.test(f.name));
  return {
    name: get("full_name") ?? ([first, last].filter(Boolean).join(" ") || null),
    phone: get("phone_number"),
    email: get("email"),
    need: needFromText(
      custom
        .filter((f) => f !== whenField)
        .map((f) => f.values.join(" "))
        .join(" ") || customText,
    ),
    timing: timingFromText(whenField?.values.join(" ")),
    answers,
  };
}

async function activity(client: PoolClient, leadId: string, kind: string, detail: object = {}, at?: Date) {
  await client.query(
    `insert into lead_activities (clinic_id, lead_id, kind, detail, at)
     values (app.current_clinic_id(), $1, $2, $3, coalesce($4, now()))`,
    [leadId, kind, JSON.stringify(detail), at ?? null],
  );
}

/** When staff can call: now if the clinic is open, else the next opening (within a week). */
export async function nextCallTime(client: PoolClient, now: Date): Promise<Date> {
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const hours = (
    await client.query(
      `select weekday, extract(hour from start_time) * 60 + extract(minute from start_time) as s,
              extract(hour from end_time) * 60 + extract(minute from end_time) as e
       from working_hours where doctor_id is null order by weekday, start_time`,
    )
  ).rows.map((r) => ({ weekday: r.weekday as number, s: Number(r.s), e: Number(r.e) }));
  if (!hours.length) return now;
  const today = localDateOf(now, tz);
  for (let d = 0; d < 8; d++) {
    const date = addDays(today, d);
    const holiday = (await client.query("select 1 from holidays where date = $1", [date])).rowCount;
    if (holiday) continue;
    const minutes = d === 0 ? localMinutesOf(now, tz) : -1;
    for (const h of hours.filter((x) => x.weekday === weekdayOf(date))) {
      if (minutes >= h.s && minutes < h.e) return now;
      if (minutes < h.s) return zonedInstant(date, h.s, tz);
    }
  }
  return now;
}

/**
 * A "call this lead" task for staff, due within 15 minutes of the clinic being open. The detail carries
 * everything the lead told us, so the caller starts informed.
 */
export async function leadCallTask(
  client: PoolClient,
  leadId: string,
  reason: "hot" | "asked_call" | "no_booking" | "callback" | "final",
  now: Date,
  at?: Date,
): Promise<string | null> {
  const l = (await client.query("select * from leads where id = $1", [leadId])).rows[0];
  if (!l || !OPEN.includes(l.stage)) return null;
  const due = new Date((at ?? (await nextCallTime(client, now))).getTime() + (at ? 0 : 15 * 60_000));
  const why = {
    hot: "Hot lead: call now",
    asked_call: "Lead asked for a call",
    no_booking: "New lead has not booked",
    callback: "Call back (as agreed)",
    final: "Last try: lead has not responded",
  }[reason];
  const lines = [
    `${l.source === "meta_form" ? "Facebook/Instagram form" : l.source === "ctwa" ? "WhatsApp ad" : l.source}${l.campaign ? ` · ${l.campaign}` : ""}`,
    l.need ? `Wants: ${l.need}` : null,
    l.timing ? `When: ${l.timing}` : null,
    ...Object.entries((l.answers ?? {}) as Record<string, string>)
      .filter(([k]) => !["full_name", "phone_number", "email"].includes(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
    l.notes ? `Notes: ${l.notes}` : null,
  ].filter(Boolean);
  const { rows } = await client.query(
    `insert into tasks (clinic_id, kind, priority, title, detail, lead_id, due_at, created_by, dedupe_key)
     values (app.current_clinic_id(), 'lead', $1, $2, $3, $4, $5, 'leads', $6)
     on conflict (clinic_id, dedupe_key) do nothing returning id`,
    [
      reason === "hot" || reason === "asked_call" ? "high" : "normal",
      `${why}: ${l.name ?? l.phone}`,
      lines.join("\n"),
      leadId,
      due,
      `lead-call:${leadId}:${reason}${reason === "callback" ? `:${due.toISOString()}` : ""}`,
    ],
  );
  if (rows[0]) {
    await activity(client, leadId, "call_task", { reason, due }, now);
    // Hot leads and call requests also ping the clinic's chosen staff phone on WhatsApp, so someone
    // calls within minutes even if nobody is looking at the dashboard.
    const alertPhone = (
      await client.query(
        "select settings->'leads'->>'alertPhone' as p from clinics where id = app.current_clinic_id()",
      )
    ).rows[0]?.p as string | null;
    if (alertPhone && (reason === "hot" || reason === "asked_call"))
      await enqueueMessage(client, {
        to: alertPhone,
        category: "transactional",
        purpose: "staff_lead_alert",
        dedupeKey: `lead-alert:${leadId}:${reason}`,
        payload: {
          kind: "template",
          purpose: "staff_alert",
          language: "en",
          params: [
            reason === "hot" ? "hot lead" : "lead asked for a call",
            `${l.name ?? "New lead"} ${l.phone}`,
            lines.slice(0, 3).join(". "),
          ],
        },
      });
  }
  return rows[0]?.id ?? null;
}

export interface NewLead {
  source: LeadSource;
  phone: string;
  name?: string | null;
  email?: string | null;
  externalId?: string | null;
  campaign?: string | null;
  ad?: string | null;
  need?: LeadNeed | null;
  timing?: LeadTiming | null;
  answers?: Record<string, string>;
  notes?: string | null;
  now?: Date;
  /** The person wrote to us first (Click-to-WhatsApp): the assistant is already answering them. */
  alreadyTalking?: boolean;
}

/**
 * Records a lead once. The same ad event twice, or the same phone with a lead still open in the last 30
 * days, returns the existing lead instead of a duplicate. Starts the follow-up (first message at once) and,
 * for hot leads, a call task for staff.
 */
export async function createLead(
  client: PoolClient,
  input: NewLead,
): Promise<{ id: string; created: boolean }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new DomainError("invalid", "The phone number is not valid");
  const now = input.now ?? new Date();
  if (input.externalId) {
    const same = (
      await client.query("select id from leads where source = $1 and external_id = $2", [
        input.source,
        input.externalId,
      ])
    ).rows[0];
    if (same) return { id: same.id, created: false };
  }
  const open = (
    await client.query(
      `select id from leads where phone = $1 and stage = any($2) and created_at > $3::timestamptz - interval '30 days'
       order by created_at desc limit 1`,
      [phone, OPEN, now],
    )
  ).rows[0];
  if (open) {
    await activity(
      client,
      open.id,
      "note",
      { text: `Came again from ${input.source}${input.campaign ? ` (${input.campaign})` : ""}` },
      now,
    );
    return { id: open.id, created: false };
  }
  const need = input.need ?? null;
  const timing = input.timing ?? null;
  const score = scoreLead(need, timing);
  const patient = (
    await client.query(
      "select id from patients where (phone = $1 or alt_phone = $1) and deleted_at is null order by created_at limit 1",
      [phone],
    )
  ).rows[0];
  const { rows } = await client.query(
    `insert into leads (clinic_id, source, external_id, campaign, ad, name, phone, email, need, timing, answers, score,
                        stage, patient_id, notes, first_contact_at, first_reply_at, created_at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $16)
     returning id`,
    [
      input.source,
      input.externalId ?? null,
      input.campaign?.slice(0, 200) ?? null,
      input.ad?.slice(0, 200) ?? null,
      input.name?.trim().slice(0, 100) || null,
      phone,
      input.email?.trim().slice(0, 200) || null,
      need,
      timing,
      JSON.stringify(input.answers ?? {}),
      score,
      input.alreadyTalking ? "engaged" : "new",
      patient?.id ?? null,
      input.notes?.slice(0, 1000) ?? null,
      input.alreadyTalking ? now : null,
      now,
    ],
  );
  const id = rows[0].id as string;
  await activity(
    client,
    id,
    "created",
    { source: input.source, campaign: input.campaign ?? null, score },
    now,
  );
  // The first WhatsApp goes at once; someone already chatting with the assistant skips it.
  await client.query(
    `insert into followup_runs (clinic_id, kind, subject_type, subject_id, patient_id, phone, step, next_at)
     values (app.current_clinic_id(), 'lead', 'lead', $1, $2, $3, $4, $5) on conflict do nothing`,
    [
      id,
      patient?.id ?? null,
      phone,
      input.alreadyTalking ? 1 : 0,
      input.alreadyTalking ? new Date(now.getTime() + 3 * 3600_000) : now,
    ],
  );
  if (score === "hot") await leadCallTask(client, id, "hot", now);
  return { id, created: true };
}

/** The lead answered a qualifying question (by button or to staff). */
export async function qualifyLead(
  client: PoolClient,
  leadId: string,
  input: { need?: LeadNeed; timing?: LeadTiming },
  now: Date = new Date(),
) {
  const l = (await client.query("select need, timing, score, stage from leads where id = $1", [leadId]))
    .rows[0];
  if (!l) throw new DomainError("not_found", "Lead not found");
  const need = input.need ?? l.need;
  const timing = input.timing ?? l.timing;
  const score = scoreLead(need, timing);
  await client.query(
    `update leads set need = $2, timing = $3, score = $4,
            stage = case when stage in ('new', 'contacted', 'engaged') and $3::text is not null then 'qualified' else stage end
     where id = $1`,
    [leadId, need, timing, score],
  );
  await activity(client, leadId, "qualified", { need, timing, score }, now);
  if (score === "hot" && l.score !== "hot") await leadCallTask(client, leadId, "hot", now);
  return { score };
}

/** A message from a lead's phone: they are talking to us. */
export async function leadReplied(client: PoolClient, phone: string, now: Date) {
  const { rows } = await client.query(
    `update leads set stage = case when stage in ('new', 'contacted') then 'engaged' else stage end,
            first_reply_at = coalesce(first_reply_at, $2)
     where phone = $1 and stage = any($3) and first_reply_at is null returning id`,
    [phone, now, OPEN],
  );
  for (const r of rows) await activity(client, r.id, "replied", {}, now);
}

/** The first message to the lead went out (speed to lead is measured to here). */
export async function leadContacted(client: PoolClient, leadId: string, now: Date) {
  const { rowCount } = await client.query(
    `update leads set first_contact_at = coalesce(first_contact_at, $2),
            stage = case when stage = 'new' then 'contacted' else stage end
     where id = $1 and first_contact_at is null`,
    [leadId, now],
  );
  if (rowCount) await activity(client, leadId, "message", { first: true }, now);
}

export type CallOutcome = "booked" | "callback" | "no_answer" | "not_interested" | "wrong_number";

/** Staff tell us how the call went. */
export async function recordCallOutcome(
  client: PoolClient,
  leadId: string,
  input: {
    outcome: CallOutcome;
    note?: string | null;
    callbackAt?: Date | null;
    userId?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const l = (await client.query("select stage from leads where id = $1 for update", [leadId])).rows[0];
  if (!l) throw new DomainError("not_found", "Lead not found");
  if (input.outcome === "callback" && !input.callbackAt)
    throw new DomainError("invalid", "Choose when to call back");
  await client.query(
    `update leads set first_call_at = coalesce(first_call_at, $2), first_contact_at = coalesce(first_contact_at, $2),
            stage = case when $3 in ('not_interested', 'wrong_number') then 'lost'
                         when stage in ('new', 'contacted') then 'engaged' else stage end,
            lost_reason = case when $3 in ('not_interested', 'wrong_number') then coalesce($4, $3) else lost_reason end,
            next_call_at = case when $3 = 'callback' then $5 else next_call_at end,
            notes = case when $4::text is not null then concat_ws(E'\\n', notes, $4::text) else notes end
     where id = $1`,
    [leadId, now, input.outcome, input.note?.trim() || null, input.callbackAt ?? null],
  );
  await activity(
    client,
    leadId,
    input.outcome === "not_interested" || input.outcome === "wrong_number" ? "lost" : "called",
    {
      outcome: input.outcome,
      note: input.note ?? null,
      by: input.userId ?? null,
    },
    now,
  );
  // The open call tasks for this lead are done; a call-back gets its own task at the agreed time.
  await client.query(
    "update tasks set status = 'done', resolved_at = $2, resolved_by = $3 where lead_id = $1 and status = 'open'",
    [leadId, now, input.userId ?? null],
  );
  if (input.outcome === "callback") await leadCallTask(client, leadId, "callback", now, input.callbackAt!);
  if (input.outcome === "not_interested" || input.outcome === "wrong_number")
    await client.query(
      "update followup_runs set status = 'stopped_staff', stop_reason = 'lead lost', finished_at = $2 where kind = 'lead' and subject_id = $1 and status = 'active'",
      [leadId, now],
    );
}

/** Staff reopen a lead closed by mistake, or add a note. */
export async function reopenLead(client: PoolClient, leadId: string, now: Date = new Date()) {
  await client.query(
    "update leads set stage = 'engaged', lost_reason = null where id = $1 and stage in ('lost', 'unresponsive')",
    [leadId],
  );
  await activity(client, leadId, "reopened", {}, now);
}

/**
 * Moves leads forward from what happened in the clinic: an appointment booked from the lead's phone after the
 * lead came in → booked; that visit completed → visited; money received → won (with the amount). Leads whose
 * follow-up ran out without an answer → unresponsive. Runs with the follow-up job; safe to repeat.
 */
export async function syncLeads(client: PoolClient, now: Date = new Date()): Promise<{ changed: number }> {
  let changed = 0;
  const { rows } = await client.query(
    `select l.id, l.stage, l.created_at, l.phone,
            (select a.id from appointments a join patients p on p.id = a.patient_id
             where (p.phone = l.phone or p.alt_phone = l.phone) and a.created_at >= l.created_at - interval '1 hour'
               and a.status not in ('cancelled') order by a.starts_at limit 1) as appointment_id
     from leads l where l.stage not in ('won', 'lost')`,
  );
  for (const l of rows) {
    if (!l.appointment_id) {
      if (["new", "contacted", "engaged", "qualified"].includes(l.stage)) {
        const run = (
          await client.query("select status from followup_runs where kind = 'lead' and subject_id = $1", [
            l.id,
          ])
        ).rows[0];
        if (run?.status === "exhausted") {
          await client.query("update leads set stage = 'unresponsive' where id = $1", [l.id]);
          await activity(client, l.id, "lost", { reason: "no response" }, now);
          changed++;
        }
      }
      continue;
    }
    const a = (
      await client.query("select id, patient_id, status, starts_at from appointments where id = $1", [
        l.appointment_id,
      ])
    ).rows[0];
    const paid = Number(
      (
        await client.query(
          `select coalesce(sum(case kind when 'payment' then amount_paise when 'refund' then -amount_paise else 0 end), 0) as s
           from patient_ledger where patient_id = $1 and created_at >= $2`,
          [a.patient_id, l.created_at],
        )
      ).rows[0].s,
    );
    const stage: LeadStage =
      paid > 0 ? "won" : a.status === "completed" ? "visited" : a.status === "no_show" ? l.stage : "booked";
    if (stage !== l.stage && !(l.stage === "visited" && stage === "booked")) {
      await client.query(
        `update leads set stage = $2, appointment_id = $3, patient_id = $4, won_value_paise = case when $2 = 'won' then $5 else won_value_paise end
         where id = $1`,
        [l.id, stage, a.id, a.patient_id, paid],
      );
      await activity(
        client,
        l.id,
        stage,
        stage === "won" ? { paidPaise: paid } : { appointmentId: a.id },
        now,
      );
      if (stage === "booked" || stage === "visited" || stage === "won")
        await client.query(
          "update tasks set status = 'done', resolved_at = $2 where lead_id = $1 and status = 'open'",
          [l.id, now],
        );
      changed++;
    } else if (
      stage === "won" &&
      Number(paid) !==
        Number(
          (await client.query("select won_value_paise from leads where id = $1", [l.id])).rows[0]
            .won_value_paise,
        )
    ) {
      await client.query("update leads set won_value_paise = $2 where id = $1", [l.id, paid]);
    }
  }
  return { changed };
}

export async function listLeads(
  client: PoolClient,
  filter: { stage?: LeadStage | "open" | "call"; limit?: number } = {},
) {
  const { rows } = await client.query(
    `select l.id, l.source, l.campaign, l.ad, l.name, l.phone, l.need, l.timing, l.score, l.stage, l.lost_reason,
            l.first_contact_at, l.first_reply_at, l.first_call_at, l.next_call_at, l.created_at, l.appointment_id,
            l.won_value_paise,
            (select min(t.due_at) from tasks t where t.lead_id = l.id and t.status = 'open') as call_due_at,
            (select c.id from conversations c where c.phone = l.phone limit 1) as conversation_id
     from leads l
     where case $1::text
             when 'open' then l.stage in ('new', 'contacted', 'engaged', 'qualified')
             when 'call' then exists (select 1 from tasks t where t.lead_id = l.id and t.status = 'open')
             when '' then true
             else l.stage = $1 end
     order by (select min(t.due_at) from tasks t where t.lead_id = l.id and t.status = 'open') nulls last,
              case l.score when 'hot' then 0 when 'warm' then 1 else 2 end, l.created_at desc
     limit $2`,
    [filter.stage ?? "", filter.limit ?? 200],
  );
  return rows;
}

export async function leadDetail(client: PoolClient, leadId: string) {
  const lead = (await client.query("select * from leads where id = $1", [leadId])).rows[0];
  if (!lead) throw new DomainError("not_found", "Lead not found");
  const activities = (
    await client.query(
      "select kind, detail, actor, at from lead_activities where lead_id = $1 order by at, seq",
      [leadId],
    )
  ).rows;
  const conversation = (
    await client.query("select id from conversations where phone = $1 limit 1", [lead.phone])
  ).rows[0];
  return { lead, activities, conversationId: conversation?.id ?? null };
}

/**
 * The funnel for a period (leads created in it), by source and campaign: how many reached each stage, how
 * fast the first message went, and the money from converted leads.
 */
export async function leadFunnel(client: PoolClient, input: { from: Date; to: Date }) {
  const { rows } = await client.query(
    `select coalesce(campaign, source) as channel, source,
            count(*)::int as leads,
            count(*) filter (where first_contact_at is not null)::int as contacted,
            count(*) filter (where stage in ('booked', 'visited', 'won'))::int as booked,
            count(*) filter (where stage in ('visited', 'won'))::int as visited,
            count(*) filter (where stage = 'won')::int as won,
            coalesce(sum(won_value_paise) filter (where stage = 'won'), 0)::bigint as revenue,
            count(*) filter (where first_contact_at <= created_at + interval '5 minutes')::int as within5,
            percentile_cont(0.5) within group (order by extract(epoch from first_contact_at - created_at))
              filter (where first_contact_at is not null) as median_sec
     from leads where created_at >= $1 and created_at < $2
     group by 1, 2 order by leads desc`,
    [input.from, input.to],
  );
  const channels = rows.map((r) => ({
    channel: r.channel as string,
    source: r.source as LeadSource,
    leads: r.leads as number,
    contacted: r.contacted as number,
    booked: r.booked as number,
    visited: r.visited as number,
    won: r.won as number,
    revenuePaise: Number(r.revenue),
    within5min: r.within5 as number,
    medianFirstContactSec: r.median_sec === null ? null : Math.round(Number(r.median_sec)),
  }));
  const sum = (k: "leads" | "contacted" | "booked" | "visited" | "won" | "revenuePaise" | "within5min") =>
    channels.reduce((s, c) => s + c[k], 0);
  return {
    channels,
    totals: {
      leads: sum("leads"),
      contacted: sum("contacted"),
      booked: sum("booked"),
      visited: sum("visited"),
      won: sum("won"),
      revenuePaise: sum("revenuePaise"),
      within5min: sum("within5min"),
    },
  };
}

/** A lead booked in the WhatsApp chat: mark it at once (the periodic sync would catch it a few minutes later). */
export async function leadBookedInChat(
  client: PoolClient,
  input: { phone: string; appointmentId: string; patientId: string; now: Date },
) {
  const { rows } = await client.query(
    `update leads set stage = 'booked', appointment_id = $2, patient_id = $3
     where phone = $1 and stage = any($4) returning id`,
    [input.phone, input.appointmentId, input.patientId, OPEN],
  );
  for (const r of rows) {
    await activity(
      client,
      r.id,
      "booked",
      { appointmentId: input.appointmentId, by: "assistant" },
      input.now,
    );
    await client.query(
      "update tasks set status = 'done', resolved_at = $2 where lead_id = $1 and status = 'open'",
      [r.id, input.now],
    );
  }
}

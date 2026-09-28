import { formatINR, type Paise } from "@dentalos/shared";
import { reviewStats } from "../revenue/reviews";
import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { ownerContact } from "../billing/wallet";
import { addDays, localDateOf, zonedInstant, type LocalDate } from "../time";

/**
 * The owner's report (PLAN Phase 6): what happened today, this week or this month, what the assistant did,
 * money collected, and "rupees recovered", with every rupee traceable to the follow-up that preceded it.
 *
 * Rupees recovered (ASSUMPTIONS A-12, defined here): money a patient paid within 30 days after a Sentio
 * follow-up (next-sitting, estimate, missed-visit, recall, dues or lead message, call or staff task) was sent
 * to them. Each payment counts once, for the most recent follow-up before it. It shows what came in after
 * the follow-ups, not proof that the follow-up alone caused it; the list lets anyone check each rupee.
 */
export const RECOVERY_KINDS = [
  "treatment_continuity",
  "estimate",
  "no_show",
  "recall",
  "dues",
  "lead",
] as const;
export const RECOVERY_WINDOW_DAYS = 30;

export type Period = "day" | "week" | "month";

/** The period containing `date` in the clinic's time zone: the day, the week from Monday, or the month. */
export function periodRange(period: Period, date: LocalDate, tz: string) {
  let start: LocalDate = date;
  let end: LocalDate;
  if (period === "day") end = addDays(date, 1);
  else if (period === "week") {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    start = addDays(date, -((wd + 6) % 7));
    end = addDays(start, 7);
  } else {
    start = `${date.slice(0, 7)}-01`;
    const [y, m] = date.split("-").map(Number) as [number, number];
    end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  }
  return { start, end, from: zonedInstant(start, 0, tz), to: zonedInstant(end, 0, tz) };
}

export interface RecoveredPayment {
  paymentId: string;
  patientId: string;
  patient: string;
  amountPaise: number;
  paidAt: Date;
  kind: (typeof RECOVERY_KINDS)[number];
  followupAt: Date;
}

export async function recoveredPayments(
  client: PoolClient,
  input: { from: Date; to: Date },
): Promise<RecoveredPayment[]> {
  const { rows } = await client.query(
    `select pay.id as payment_id, pay.patient_id, p.name as patient, pay.amount_paise, pay.created_at as paid_at,
            touch.kind, touch.at as followup_at
     from patient_ledger pay join patients p on p.id = pay.patient_id
     cross join lateral (
       select r.kind, a.at from followup_actions a join followup_runs r on r.id = a.run_id
       left join leads l on r.subject_type = 'lead' and l.id = r.subject_id
       where (r.patient_id = pay.patient_id or l.patient_id = pay.patient_id)
         and r.kind = any($3) and a.result in ('queued', 'created', 'requested')
         and a.at <= pay.created_at and a.at > pay.created_at - make_interval(days => $4)
       order by a.at desc limit 1) touch
     where pay.kind = 'payment' and pay.created_at >= $1 and pay.created_at < $2
       and not exists (select 1 from patient_ledger x where x.reverses_id = pay.id)
     order by pay.created_at`,
    [input.from, input.to, [...RECOVERY_KINDS], RECOVERY_WINDOW_DAYS],
  );
  return rows.map((r) => ({
    paymentId: r.payment_id,
    patientId: r.patient_id,
    patient: r.patient,
    amountPaise: Number(r.amount_paise),
    paidAt: r.paid_at,
    kind: r.kind,
    followupAt: r.followup_at,
  }));
}

export async function ownerReport(client: PoolClient, input: { period: Period; date: LocalDate }) {
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const r = periodRange(input.period, input.date, tz);
  const one = async (sql: string, params: unknown[] = [r.from, r.to]) =>
    (await client.query(sql, params)).rows[0];
  const visits = await one(
    `select count(*) filter (where status = 'completed')::int as done,
            count(*) filter (where status = 'no_show')::int as no_shows,
            count(*) filter (where status = 'cancelled')::int as cancelled,
            count(*)::int as scheduled
     from appointments where starts_at >= $1 and starts_at < $2`,
  );
  const bookings = await one(
    `select count(*)::int as total,
            count(*) filter (where source = 'whatsapp')::int as whatsapp,
            count(*) filter (where source = 'voice')::int as voice
     from appointments where created_at >= $1 and created_at < $2 and source <> 'import'`,
  );
  const calls = await one(
    `select count(*)::int as total, count(*) filter (where route = 'assistant')::int as by_assistant,
            count(*) filter (where outcome = 'emergency')::int as emergencies
     from calls where started_at >= $1 and started_at < $2 and direction = 'inbound' and not is_test`,
  );
  const chats = await one(
    `select count(distinct conversation_id)::int as chats from messages
     where direction = 'in' and created_at >= $1 and created_at < $2`,
  );
  const money = await one(
    `select coalesce(sum(amount_paise) filter (where kind = 'payment'), 0)::bigint as received,
            coalesce(sum(amount_paise) filter (where kind = 'refund'), 0)::bigint as refunded
     from patient_ledger l where kind in ('payment', 'refund') and created_at >= $1 and created_at < $2
       and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)`,
  );
  const dues = await one(
    "select coalesce(sum(balance_paise), 0)::bigint as total from patient_balances where balance_paise > 0",
    [],
  );
  const leads = await one(
    `select count(*)::int as new, count(*) filter (where stage in ('booked', 'visited', 'won'))::int as booked,
            count(*) filter (where stage = 'won')::int as won
     from leads where created_at >= $1 and created_at < $2`,
  );
  const reviews = await reviewStats(client, { from: r.from, to: r.to });
  const recovered = await recoveredPayments(client, { from: r.from, to: r.to });
  const byKind: Record<string, number> = {};
  for (const p of recovered) byKind[p.kind] = (byKind[p.kind] ?? 0) + p.amountPaise;
  const tomorrow = addDays(input.date, 1);
  const next = await one(
    `select count(*)::int as booked, count(*) filter (where status = 'booked')::int as unconfirmed
     from appointments where starts_at >= $1 and starts_at < $2 and status in ('booked', 'confirmed')`,
    [zonedInstant(tomorrow, 0, tz), zonedInstant(addDays(tomorrow, 1), 0, tz)],
  );
  return {
    period: input.period,
    start: r.start,
    end: r.end,
    visits,
    bookings,
    calls: { total: calls.total, byAssistant: calls.by_assistant, emergencies: calls.emergencies },
    chats: chats.chats as number,
    collectedPaise: Number(money.received) - Number(money.refunded),
    duesPaise: Number(dues.total),
    leads,
    reviews,
    recovered: {
      totalPaise: recovered.reduce((s, p) => s + p.amountPaise, 0),
      byKind,
      payments: recovered,
    },
    tomorrow:
      input.period === "day"
        ? { date: tomorrow, booked: next.booked as number, unconfirmed: next.unconfirmed as number }
        : null,
  };
}

/**
 * At 21:00 clinic time, the day's summary goes to the owner on WhatsApp with a link to the full report.
 * Once per day (dedupe key); owners can switch it off.
 */
export async function queueNightlyReport(
  client: PoolClient,
  input: { now: Date; dashboardUrl?: string | null },
): Promise<string | null> {
  const clinic = (
    await client.query("select name, timezone, settings from clinics where id = app.current_clinic_id()")
  ).rows[0];
  if (clinic.settings?.reports?.nightly === false) return null;
  const local = localDateOf(input.now, clinic.timezone);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: clinic.timezone, hour: "2-digit", hour12: false }).format(
      input.now,
    ),
  );
  if (hour !== 21) return null;
  const owner = await ownerContact(client);
  if (!owner?.phone) return null;
  const day = await ownerReport(client, { period: "day", date: local });
  const month = await ownerReport(client, { period: "month", date: local });
  const rupees = (p: number) => formatINR(p as Paise);
  const hi = owner.language === "hi";
  const summary = hi
    ? `${day.visits.done} मरीज़ आए, ${day.bookings.total} नई बुकिंग (${day.bookings.whatsapp + day.bookings.voice} असिस्टेंट ने), ${rupees(day.collectedPaise)} जमा। इस महीने अब तक फ़ॉलो-अप के बाद ${rupees(month.recovered.totalPaise)} वापस आए। कल ${day.tomorrow!.booked} अपॉइंटमेंट।`
    : `${day.visits.done} patients seen, ${day.bookings.total} new bookings (${day.bookings.whatsapp + day.bookings.voice} by the assistant), ${rupees(day.collectedPaise)} collected. Recovered after follow-ups this month: ${rupees(month.recovered.totalPaise)}. Tomorrow: ${day.tomorrow!.booked} appointments.`;
  const link = input.dashboardUrl
    ? `${input.dashboardUrl.replace(/\/$/, "")}/reports?date=${local}`
    : hi
      ? "Sentio ऐप → रिपोर्ट"
      : "Sentio app → Reports";
  return enqueueMessage(client, {
    to: owner.phone,
    category: "transactional",
    purpose: "owner_daily_report",
    dedupeKey: `report:${local}`,
    notBefore: input.now,
    payload: {
      kind: "template",
      purpose: "owner_daily_report",
      language: owner.language,
      params: [owner.name, clinic.name, summary, link],
    },
  });
}

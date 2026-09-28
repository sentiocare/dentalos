import { formatINR, type Paise } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { walletAllows, walletStatus } from "../billing/wallet";
import { leadCallTask, leadContacted } from "../leads/leads";
import { enqueueMessage } from "../comms/outbox";
import type { TemplatePurpose } from "../comms/templates";
import { dayInWords } from "../i18n/when";
import type { JobQueue } from "../jobs";
import { addDays, localDateOf, localMinutesOf, zonedInstant, type LocalDate } from "../time";

/**
 * One follow-up engine for every "chase" (PLAN §5.3): a run per subject (a treatment sitting, an estimate,
 * an appointment) steps through a ladder of WhatsApp messages, AI calls and staff tasks, and stops by itself
 * when the goal is reached, the patient opts out, or staff stop it. Everything is keyed so running the
 * planner or the stepper twice never sends twice.
 */
export type FollowupKind =
  | "treatment_continuity"
  | "estimate"
  | "no_show"
  | "unconfirmed"
  | "recall"
  | "aftercare_checkin"
  | "dues"
  | "lead";

export interface LadderStep {
  /** Hours after the previous step (for the first step: after the run's start). */
  afterHours: number;
  /** Move to this clinic-local time of day ("10:00"), the same day or the next. */
  atLocalTime?: string;
  action: "whatsapp" | "ai_call" | "staff_task";
  template?: TemplatePurpose;
}

export const DEFAULT_LADDERS: Record<FollowupKind, LadderStep[]> = {
  treatment_continuity: [
    { afterHours: 0, action: "whatsapp", template: "treatment_next_sitting" },
    { afterHours: 72, atLocalTime: "10:30", action: "whatsapp", template: "treatment_next_sitting" },
    { afterHours: 72, atLocalTime: "10:00", action: "staff_task" },
  ],
  estimate: [
    { afterHours: 0, action: "whatsapp", template: "estimate_followup" },
    { afterHours: 120, atLocalTime: "11:00", action: "whatsapp", template: "estimate_followup" },
    { afterHours: 72, atLocalTime: "10:00", action: "staff_task" },
  ],
  no_show: [
    { afterHours: 0, action: "whatsapp", template: "no_show" },
    { afterHours: 48, atLocalTime: "10:00", action: "staff_task" },
  ],
  unconfirmed: [
    { afterHours: 0, action: "ai_call" },
    { afterHours: 2, action: "staff_task" },
  ],
  recall: [
    { afterHours: 0, action: "whatsapp", template: "recall" },
    { afterHours: 168, atLocalTime: "11:00", action: "whatsapp", template: "recall" },
    { afterHours: 168, atLocalTime: "10:00", action: "staff_task" },
  ],
  aftercare_checkin: [
    { afterHours: 0, action: "whatsapp", template: "aftercare" },
    { afterHours: 12, atLocalTime: "10:00", action: "whatsapp", template: "checkin" },
  ],
  // New leads (ASSUMPTIONS A-54): the first WhatsApp at once and an AI call 3 minutes later (the assistant
  // qualifies and books on the call); a person calls if nothing is booked within 3 hours; a nudge the next
  // morning and a second AI call that afternoon (a different time of day); another nudge, a last call by a
  // person, then two gentle check-ins a week and two weeks later (many ad leads book weeks later), then the
  // lead is closed as unresponsive. Leads already chatting on WhatsApp are not called by the assistant.
  lead: [
    { afterHours: 0, action: "whatsapp", template: "lead_welcome" },
    { afterHours: 0.05, action: "ai_call" },
    { afterHours: 3, action: "staff_task" },
    { afterHours: 21, atLocalTime: "11:00", action: "whatsapp", template: "lead_nudge" },
    { afterHours: 5, atLocalTime: "17:00", action: "ai_call" },
    { afterHours: 40, atLocalTime: "11:00", action: "whatsapp", template: "lead_nudge" },
    { afterHours: 48, atLocalTime: "10:30", action: "staff_task" },
    { afterHours: 168, atLocalTime: "11:00", action: "whatsapp", template: "lead_checkin" },
    { afterHours: 336, atLocalTime: "11:00", action: "whatsapp", template: "lead_checkin" },
  ],
  dues: [
    { afterHours: 0, action: "whatsapp", template: "dues_reminder" },
    { afterHours: 168, atLocalTime: "11:00", action: "whatsapp", template: "dues_reminder" },
    { afterHours: 168, atLocalTime: "10:00", action: "staff_task" },
  ],
};

/** Dues reminders start when a patient owes at least this much for this many days (ASSUMPTIONS A-46). */
export const DUES_DEFAULTS = { minPaise: 50_000, afterDays: 3 };

/** AI calls only between these clinic-local hours (§6.9, ASSUMPTIONS A-7). */
export const DEFAULT_CALL_HOURS: [string, string] = ["09:00", "20:00"];

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export function nextStepTime(from: Date, step: LadderStep, timezone: string): Date {
  const at = new Date(from.getTime() + step.afterHours * 3600_000);
  if (!step.atLocalTime) return at;
  const date = localDateOf(at, timezone);
  const target = zonedInstant(date, toMin(step.atLocalTime), timezone);
  return target >= at ? target : zonedInstant(addDays(date, 1), toMin(step.atLocalTime), timezone);
}

async function ladders(client: PoolClient): Promise<Record<FollowupKind, LadderStep[] | null>> {
  const { rows } = await client.query("select kind, steps, active from followup_ladders");
  const out = { ...DEFAULT_LADDERS } as Record<FollowupKind, LadderStep[] | null>;
  for (const r of rows) out[r.kind as FollowupKind] = r.active ? (r.steps as LadderStep[]) : null;
  return out;
}

interface ClinicInfo {
  name: string;
  timezone: string;
  defaultLanguage: string;
  settings: {
    voice?: { outboundHours?: [string, string]; outboundCalls?: boolean; leadCalls?: boolean };
    billing?: { duesMinPaise?: number; duesAfterDays?: number };
  };
}

async function clinicInfo(client: PoolClient): Promise<ClinicInfo> {
  const c = (
    await client.query(
      "select name, timezone, default_language, settings from clinics where id = app.current_clinic_id()",
    )
  ).rows[0];
  return {
    name: c.name,
    timezone: c.timezone,
    defaultLanguage: c.default_language,
    settings: c.settings ?? {},
  };
}

// ------------------------------------------------------------------------------------------------ planner

interface NewRun {
  kind: FollowupKind;
  subjectType: "treatment_step" | "estimate" | "appointment" | "ledger_entry";
  subjectId: string;
  patientId: string;
  phone: string | null;
  startAt: Date;
}

async function startRun(client: PoolClient, r: NewRun): Promise<boolean> {
  const { rowCount } = await client.query(
    `insert into followup_runs (clinic_id, kind, subject_type, subject_id, patient_id, phone, next_at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6) on conflict (clinic_id, kind, subject_id) do nothing`,
    [r.kind, r.subjectType, r.subjectId, r.patientId, r.phone, r.startAt],
  );
  return (rowCount ?? 0) > 0;
}

const at10 = (date: LocalDate, tz: string) => zonedInstant(date, 10 * 60, tz);

/** Finds new things to chase and starts a run for each (idempotent). */
export async function planFollowups(
  client: PoolClient,
  now: Date = new Date(),
  deps: { jobs?: JobQueue } = {},
): Promise<Record<FollowupKind | "deposits", number>> {
  const clinic = await clinicInfo(client);
  const tz = clinic.timezone;
  const today = localDateOf(now, tz);
  const active = await ladders(client);
  const started: Record<FollowupKind | "deposits", number> = {
    treatment_continuity: 0,
    estimate: 0,
    no_show: 0,
    unconfirmed: 0,
    recall: 0,
    aftercare_checkin: 0,
    dues: 0,
    lead: 0,
    deposits: 0,
  };
  const add = async (r: NewRun) => {
    if (active[r.kind] && (await startRun(client, r))) started[r.kind]++;
  };

  // The next sitting of an accepted plan, from the day before its window opens, while nothing is booked.
  const steps = await client.query(
    `select s.id, s.expected_from::text, p.patient_id, pa.phone
     from treatment_steps s join treatment_plans p on p.id = s.plan_id join patients pa on pa.id = p.patient_id
     where p.status in ('accepted', 'in_progress') and s.status in ('pending', 'missed') and s.appointment_id is null
       and s.expected_from is not null and s.expected_from <= $1::date + 1 and pa.deleted_at is null
       and not exists (select 1 from treatment_steps e where e.plan_id = s.plan_id and e.seq < s.seq and e.status not in ('done', 'skipped'))`,
    [today],
  );
  for (const s of steps.rows) {
    const start = at10(addDays(s.expected_from, -1), tz);
    await add({
      kind: "treatment_continuity",
      subjectType: "treatment_step",
      subjectId: s.id,
      patientId: s.patient_id,
      phone: s.phone,
      startAt: start > now ? start : now,
    });
  }

  // Sent estimates: first follow-up two days later.
  const estimates = await client.query(
    `select e.id, e.sent_at, e.patient_id, p.phone from estimates e join patients p on p.id = e.patient_id
     where e.status = 'sent' and p.deleted_at is null`,
  );
  for (const e of estimates.rows)
    await add({
      kind: "estimate",
      subjectType: "estimate",
      subjectId: e.id,
      patientId: e.patient_id,
      phone: e.phone,
      startAt: new Date(e.sent_at.getTime() + 48 * 3600_000),
    });

  // No-shows in the last two weeks: a message two hours after the appointment ended.
  const noShows = await client.query(
    `select a.id, a.ends_at, a.patient_id, p.phone from appointments a join patients p on p.id = a.patient_id
     where a.status = 'no_show' and a.starts_at > $1::timestamptz - interval '14 days' and a.starts_at <= $1 and p.deleted_at is null`,
    [now],
  );
  for (const a of noShows.rows)
    await add({
      kind: "no_show",
      subjectType: "appointment",
      subjectId: a.id,
      patientId: a.patient_id,
      phone: a.phone,
      startAt: new Date(a.ends_at.getTime() + 2 * 3600_000),
    });

  // Booked more than a day ahead and still not confirmed: an AI call 16 hours before (the evening before a
  // morning visit), within calling hours.
  const unconfirmed = await client.query(
    `select a.id, a.starts_at, a.patient_id, p.phone from appointments a join patients p on p.id = a.patient_id
     where a.status = 'booked' and a.starts_at > $1::timestamptz + interval '2 hours' and a.starts_at < $1::timestamptz + interval '36 hours'
       and a.created_at < a.starts_at - interval '24 hours' and a.source <> 'import' and p.deleted_at is null`,
    [now],
  );
  for (const a of unconfirmed.rows) {
    const start = new Date(a.starts_at.getTime() - 16 * 3600_000);
    await add({
      kind: "unconfirmed",
      subjectType: "appointment",
      subjectId: a.id,
      patientId: a.patient_id,
      phone: a.phone,
      startAt: start > now ? start : now,
    });
  }

  // Completed visits: recall after the procedure's recall period; after-care and next-day check-in.
  const done = await client.query(
    `select a.id, a.ends_at, a.patient_id, p.phone, pt.recall_months, pt.checkin,
            coalesce((pt.aftercare->>'approved')::boolean, false) as aftercare_ok
     from appointments a join patients p on p.id = a.patient_id join procedure_types pt on pt.id = a.procedure_type_id
     where a.status = 'completed' and a.ends_at <= $1 and a.ends_at > $1::timestamptz - interval '3 years' and p.deleted_at is null
       and (pt.recall_months is not null or pt.checkin or pt.aftercare is not null)`,
    [now],
  );
  for (const a of done.rows) {
    if (a.recall_months) {
      const due = localDateOf(a.ends_at, tz);
      const [y, m, d] = due.split("-").map(Number) as [number, number, number];
      const target = new Date(Date.UTC(y, m - 1 + a.recall_months, Math.min(d, 28)));
      const startAt = at10(target.toISOString().slice(0, 10), tz);
      // Only recalls falling due now or later (or within the last month): on the first run for a clinic
      // with years of history, old visits must not all get a recall at once. Those patients are reached
      // with an owner-approved reactivation campaign instead.
      if (startAt.getTime() > now.getTime() - 30 * 86_400_000)
        await add({
          kind: "recall",
          subjectType: "appointment",
          subjectId: a.id,
          patientId: a.patient_id,
          phone: a.phone,
          startAt: startAt > now ? startAt : now,
        });
    }
    const recent = now.getTime() - a.ends_at.getTime() < 2 * 86_400_000;
    if (recent && (a.checkin || a.aftercare_ok))
      await add({
        kind: "aftercare_checkin",
        subjectType: "appointment",
        subjectId: a.id,
        patientId: a.patient_id,
        phone: a.phone,
        startAt: new Date(a.ends_at.getTime() + 3600_000),
      });
  }

  // Dues: a patient who has owed money for a few days, with no reminder running. The subject is their latest
  // charge, so a later bill starts a fresh reminder once the earlier one is settled.
  const minDues = clinic.settings.billing?.duesMinPaise ?? DUES_DEFAULTS.minPaise;
  const afterDays = clinic.settings.billing?.duesAfterDays ?? DUES_DEFAULTS.afterDays;
  const dues = await client.query(
    `select b.patient_id, p.phone,
            (select l.id from patient_ledger l where l.patient_id = b.patient_id and l.kind = 'charge'
             order by l.created_at desc, l.id desc limit 1) as charge_id,
            (select max(l.created_at) from patient_ledger l where l.patient_id = b.patient_id and l.kind = 'charge') as last_charge
     from patient_balances b join patients p on p.id = b.patient_id
     where b.balance_paise >= $1 and p.deleted_at is null and p.phone is not null
       and not exists (select 1 from followup_runs r where r.kind = 'dues' and r.patient_id = b.patient_id and r.status = 'active')`,
    [minDues],
  );
  for (const d of dues.rows) {
    if (!d.charge_id || now.getTime() - d.last_charge.getTime() < afterDays * 86_400_000) continue;
    const start = at10(today, tz);
    await add({
      kind: "dues",
      subjectType: "ledger_entry",
      subjectId: d.charge_id,
      patientId: d.patient_id,
      phone: d.phone,
      startAt:
        start > now
          ? start
          : nextStepTime(now, { afterHours: 0, atLocalTime: "10:00", action: "whatsapp" }, tz),
    });
  }

  // Deposits: online bookings for procedures that ask for an advance get a payment link (made by the worker).
  const deposits = await client.query(
    `update appointments a set deposit_status = 'requested', deposit_paise = pt.deposit_paise
     from procedure_types pt
     where pt.id = a.procedure_type_id and pt.deposit_paise > 0 and a.deposit_status is null
       and a.source in ('whatsapp', 'voice') and a.status in ('booked', 'confirmed') and a.starts_at > $1
     returning a.id`,
    [now],
  );
  if (deposits.rows.length) {
    const clinicId = (await client.query("select app.current_clinic_id() as id")).rows[0].id;
    for (const d of deposits.rows) {
      started.deposits++;
      await deps.jobs?.add(
        "request_deposit",
        { appointmentId: d.id, clinicId },
        { jobKey: `deposit:${d.id}` },
      );
    }
  }
  return started;
}

// ------------------------------------------------------------------------------------------------ stepper

type Outcome = "stopped_success" | "stopped_obsolete" | null;

/** Has the chase already achieved what it was for (or become pointless)? */
async function goal(client: PoolClient, run: RunRow, now: Date): Promise<Outcome> {
  const q = async (sql: string) => {
    // Pass only the parameters the query uses ($1 subject, $2 patient, $3 now).
    const used = Math.max(...[...sql.matchAll(/\$(\d)/g)].map((m) => Number(m[1])));
    return (await client.query(sql, [run.subject_id, run.patient_id, now].slice(0, used))).rows[0];
  };
  switch (run.kind) {
    case "treatment_continuity": {
      const r = await q(
        `select s.status, p.status as plan_status from treatment_steps s join treatment_plans p on p.id = s.plan_id where s.id = $1`,
      );
      if (!r || ["abandoned", "completed"].includes(r.plan_status)) return "stopped_obsolete";
      return ["scheduled", "done", "skipped"].includes(r.status) ? "stopped_success" : null;
    }
    case "estimate": {
      const r = await q(
        `select e.status, exists (select 1 from appointments a where a.patient_id = $2 and a.created_at > e.sent_at
                                   and a.status not in ('cancelled', 'no_show')) as booked
         from estimates e where e.id = $1`,
      );
      if (!r) return "stopped_obsolete";
      if (r.booked || r.status === "accepted") return "stopped_success";
      return r.status === "sent" ? null : "stopped_obsolete";
    }
    case "no_show": {
      const r = await q(
        `select exists (select 1 from appointments a, appointments x where x.id = $1 and a.patient_id = $2 and a.id <> x.id
                        and a.created_at > x.starts_at and a.status not in ('cancelled', 'no_show')) as rebooked`,
      );
      return r.rebooked ? "stopped_success" : null;
    }
    case "unconfirmed": {
      const r = await q(`select status, starts_at from appointments where id = $1`);
      if (!r || r.status === "cancelled" || r.starts_at.getTime() - now.getTime() < 60 * 60_000)
        return "stopped_obsolete";
      return r.status === "booked" ? null : "stopped_success";
    }
    case "recall": {
      const r = await q(
        `select exists (select 1 from appointments a, appointments x where x.id = $1 and a.patient_id = $2 and a.id <> x.id
                        and a.starts_at > x.ends_at and a.status not in ('cancelled', 'no_show')) as returned`,
      );
      return r.returned ? "stopped_success" : null;
    }
    case "aftercare_checkin":
      return null;
    case "lead": {
      const r = await q(`select stage from leads where id = $1`);
      if (!r || ["lost", "unresponsive"].includes(r.stage)) return "stopped_obsolete";
      return ["booked", "visited", "won"].includes(r.stage) ? "stopped_success" : null;
    }
    case "dues": {
      const r = await q(
        `select coalesce(sum(balance_paise), 0)::bigint as owed from patient_balances
         where patient_id = (select patient_id from patient_ledger where id = $1)`,
      );
      return Number(r.owed) <= 0 ? "stopped_success" : null;
    }
  }
}

interface RunRow {
  id: string;
  kind: FollowupKind;
  subject_id: string;
  patient_id: string | null;
  phone: string | null;
  step: number;
  next_at: Date;
  patient_name: string;
  language_pref: string | null;
}

export type CallRequest =
  | { runId: string; step: number; purpose: "confirm_appointment"; appointmentId: string }
  | { runId: string; step: number; purpose: "lead_call"; leadId: string };

/** A dues reminder waiting for its payment link (made by the worker, which holds the gateway keys). */
export interface LinkRequest {
  runId: string;
  patientId: string;
  amountPaise: number;
}

export interface StepResult {
  stopped: number;
  messages: number;
  calls: CallRequest[];
  tasks: number;
  links: LinkRequest[];
}

function inHours(now: Date, tz: string, hours: [string, string]) {
  const m = localMinutesOf(now, tz);
  return m >= toMin(hours[0]) && m < toMin(hours[1]);
}

function nextOpening(now: Date, tz: string, hours: [string, string]): Date {
  const today = localDateOf(now, tz);
  const start = zonedInstant(today, toMin(hours[0]), tz);
  return now < start ? start : zonedInstant(addDays(today, 1), toMin(hours[0]), tz);
}

/** Runs every due step: checks the goal and opt-outs, takes the action, schedules the next step. */
export async function advanceFollowups(
  client: PoolClient,
  now: Date = new Date(),
  limit = 200,
): Promise<StepResult> {
  const clinic = await clinicInfo(client);
  const tz = clinic.timezone;
  const allLadders = await ladders(client);
  const callHours =
    (clinic.settings.voice?.outboundHours as [string, string] | undefined) ?? DEFAULT_CALL_HOURS;
  const canCall =
    clinic.settings.voice?.outboundCalls !== false &&
    ((await client.query("select 1 from clinic_channels where kind = 'voice' and active")).rowCount ?? 0) > 0;
  const canCallLeads = canCall && clinic.settings.voice?.leadCalls !== false;
  const result: StepResult = { stopped: 0, messages: 0, calls: [], tasks: 0, links: [] };
  const wallet = await walletStatus(client, now);

  const { rows } = await client.query<RunRow>(
    `select r.id, r.kind, r.subject_id, r.patient_id, r.phone, r.step, r.next_at,
            coalesce(p.name, l.name, '') as patient_name, p.language_pref
     from followup_runs r left join patients p on p.id = r.patient_id
     left join leads l on r.subject_type = 'lead' and l.id = r.subject_id
     where r.status = 'active' and r.next_at <= $1 order by r.next_at, r.id limit $2 for update of r skip locked`,
    [now, limit],
  );

  for (const run of rows) {
    const stop = async (status: string, reason: string | null = null) => {
      await client.query(
        "update followup_runs set status = $2, stop_reason = $3, finished_at = $4 where id = $1",
        [run.id, status, reason, now],
      );
      result.stopped++;
    };
    const ladder = allLadders[run.kind];
    if (!ladder) {
      await stop("stopped_staff", "ladder switched off");
      continue;
    }
    const outcome = await goal(client, run, now);
    if (outcome) {
      await stop(outcome);
      continue;
    }
    if (run.phone) {
      const optedOut = await client.query(
        "select 1 from opt_outs where phone = $1 and revoked_at is null and category in ('all', 'transactional') and channel in ('all', 'whatsapp')",
        [run.phone],
      );
      if (optedOut.rowCount) {
        await stop("stopped_optout");
        continue;
      }
    }
    const step = ladder[run.step];
    if (!step) {
      await stop("exhausted");
      continue;
    }
    // Recalls are optional spend: they wait while the usage wallet is paused (PLAN §5.6).
    if (run.kind === "recall" && !walletAllows(wallet, "recall")) {
      await client.query("update followup_runs set next_at = $2 where id = $1", [
        run.id,
        new Date(now.getTime() + 6 * 3600_000),
      ]);
      continue;
    }

    const record = (
      action: string,
      res: string,
      extra: { outboxId?: string | null; taskId?: string | null; call?: CallRequest } = {},
    ) =>
      client.query(
        `insert into followup_actions (clinic_id, run_id, step, action, result, outbox_id, task_id, call_request, at)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8) on conflict (run_id, step) do nothing`,
        [
          run.id,
          run.step,
          action,
          res,
          extra.outboxId ?? null,
          extra.taskId ?? null,
          extra.call ? JSON.stringify(extra.call) : null,
          now,
        ],
      );

    let action = step.action;
    if (
      action === "ai_call" &&
      (!(run.kind === "lead" ? canCallLeads : canCall) ||
        !run.phone ||
        !walletAllows(wallet, "ai_outbound_call"))
    )
      action = "staff_task";
    if (action === "ai_call" && !inHours(now, tz, callHours)) {
      // Calls wait for calling hours; if that is too late to be useful, a person follows up instead.
      const opening = nextOpening(now, tz, callHours);
      const subject = (
        await client.query("select starts_at from appointments where id = $1", [run.subject_id])
      ).rows[0];
      // A lead has no deadline: its call simply waits for the morning.
      if (run.kind === "lead" || (subject && opening.getTime() < subject.starts_at.getTime() - 60 * 60_000)) {
        await client.query("update followup_runs set next_at = $2 where id = $1", [run.id, opening]);
        continue;
      }
      action = "staff_task";
    }

    if (action === "whatsapp" && run.kind === "dues" && run.phone) {
      // The reminder carries a payment link for the exact amount owed; wait for the worker to make it.
      const owed = Number(
        (
          await client.query("select balance_paise from patient_balances where patient_id = $1", [
            run.patient_id,
          ])
        ).rows[0]?.balance_paise ?? 0,
      );
      const link = await client.query(
        `select 1 from payment_links where patient_id = $1 and purpose = 'dues' and status = 'created'
           and amount_paise = $2 and created_at > now() - interval '10 days'`,
        [run.patient_id, owed],
      );
      if (!link.rowCount) {
        result.links.push({ runId: run.id, patientId: run.patient_id!, amountPaise: owed });
        continue;
      }
    }

    if (action === "whatsapp") {
      const message = await buildMessage(client, run, step.template!, clinic);
      if (!message) await record("whatsapp", "skipped_no_content");
      else if (!run.phone) await record("whatsapp", "skipped_no_phone");
      else {
        const outboxId = await enqueueMessage(client, {
          to: run.phone,
          category: "transactional",
          purpose: `followup_${run.kind}`,
          patientId: run.patient_id,
          appointmentId: message.appointmentId ?? null,
          dedupeKey: `followup:${run.id}:${run.step}`,
          notBefore: now,
          payload: {
            kind: "template",
            purpose: step.template!,
            language: message.language,
            params: message.params,
            buttonPayloads: message.buttons,
          },
        });
        await record("whatsapp", "queued", { outboxId });
        if (outboxId) result.messages++;
        if (outboxId && run.kind === "lead") await leadContacted(client, run.subject_id, now);
      }
    } else if (action === "ai_call") {
      // A lead already chatting with the assistant on WhatsApp is not interrupted with a call.
      const chatting =
        run.kind === "lead" &&
        (
          await client.query("select 1 from leads where id = $1 and first_reply_at is not null", [
            run.subject_id,
          ])
        ).rowCount;
      if (chatting) await record("ai_call", "skipped_chatting");
      else {
        const call: CallRequest =
          run.kind === "lead"
            ? { runId: run.id, step: run.step, purpose: "lead_call", leadId: run.subject_id }
            : {
                runId: run.id,
                step: run.step,
                purpose: "confirm_appointment",
                appointmentId: run.subject_id,
              };
        await record("ai_call", "requested", { call });
        result.calls.push(call);
      }
    } else {
      // A lead's task is a call with everything the lead told us; the last call in the ladder is the final try.
      const later = ladder.slice(run.step + 1).some((s) => s.action === "staff_task");
      const taskId =
        run.kind === "lead"
          ? await leadCallTask(client, run.subject_id, later ? "no_booking" : "final", now)
          : await staffTask(client, run, now);
      await record("staff_task", "created", { taskId });
      if (taskId) result.tasks++;
    }

    const next = ladder[run.step + 1];
    if (next) {
      await client.query("update followup_runs set step = step + 1, next_at = $2 where id = $1", [
        run.id,
        nextStepTime(now, next, tz),
      ]);
    } else {
      await client.query(
        "update followup_runs set step = step + 1, status = 'exhausted', finished_at = $2 where id = $1",
        [run.id, now],
      );
      // A ladder that ran out without reaching its goal leaves the patient with a person (PLAN §5.3).
      if (action !== "staff_task" && run.kind !== "aftercare_checkin" && run.kind !== "lead") {
        await staffTask(client, { ...run, step: run.step + 1 }, now);
        result.tasks++;
      }
    }
  }
  return result;
}

/** Staff pressed "stop" on a follow-up (e.g. the patient said so at the desk). */
export async function stopFollowup(client: PoolClient, runId: string, reason: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "update followup_runs set status = 'stopped_staff', stop_reason = $2, finished_at = now() where id = $1 and status = 'active'",
    [runId, reason],
  );
  return (rowCount ?? 0) > 0;
}

function lang(pref: string | null, clinicDefault: string): "en" | "hi" {
  if (pref === "en") return "en";
  if (pref === "hi" || pref === "hinglish") return "hi";
  return clinicDefault === "en" ? "en" : "hi";
}

const MONTHS = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  hi: [
    "जनवरी",
    "फ़रवरी",
    "मार्च",
    "अप्रैल",
    "मई",
    "जून",
    "जुलाई",
    "अगस्त",
    "सितंबर",
    "अक्टूबर",
    "नवंबर",
    "दिसंबर",
  ],
};

/** "between 12 and 16 January" / "12–16 जनवरी के बीच". */
export function windowInWords(from: LocalDate, to: LocalDate, language: "en" | "hi"): string {
  const [, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [, tm, td] = to.split("-").map(Number) as [number, number, number];
  const f =
    language === "hi"
      ? `${fd} ${fm === tm ? "" : MONTHS.hi[fm - 1]}`.trim()
      : `${fd}${fm === tm ? "" : ` ${MONTHS.en[fm - 1]}`}`;
  return language === "hi"
    ? `${f}–${td} ${MONTHS.hi[tm - 1]} के बीच`
    : `between ${f} and ${td} ${MONTHS.en[tm - 1]}`;
}

async function buildMessage(
  client: PoolClient,
  run: RunRow,
  template: TemplatePurpose,
  clinic: ClinicInfo,
): Promise<{ language: "en" | "hi"; params: string[]; buttons?: string[]; appointmentId?: string } | null> {
  let language = lang(run.language_pref, clinic.defaultLanguage);
  const name = run.patient_name;
  switch (template) {
    case "treatment_next_sitting": {
      const s = (
        await client.query(
          `select pt.name, pt.name_hi, s.expected_from::text, s.expected_to::text from treatment_steps s
           join procedure_types pt on pt.id = s.procedure_type_id where s.id = $1`,
          [run.subject_id],
        )
      ).rows[0];
      if (!s) return null;
      const procedure = language === "hi" && s.name_hi ? s.name_hi : s.name;
      return {
        language,
        params: [
          name,
          clinic.name,
          procedure,
          windowInWords(s.expected_from, s.expected_to ?? s.expected_from, language),
        ],
        buttons: [`book_step:${run.subject_id}`, `callme:${run.id}`],
      };
    }
    case "estimate_followup": {
      const e = (await client.query("select total_paise from estimates where id = $1", [run.subject_id]))
        .rows[0];
      if (!e) return null;
      return {
        language,
        params: [name, clinic.name, formatINR(Number(e.total_paise) as Paise)],
        buttons: [`estimate_ok:${run.subject_id}`, `estimate_call:${run.subject_id}`],
      };
    }
    case "no_show": {
      const a = (await client.query("select starts_at from appointments where id = $1", [run.subject_id]))
        .rows[0];
      if (!a) return null;
      return {
        language,
        params: [name, clinic.name, dayInWords(a.starts_at, clinic.timezone, language)],
        buttons: [`rebook:${run.subject_id}`, `callme:${run.id}`],
        appointmentId: run.subject_id,
      };
    }
    case "recall": {
      const a = (
        await client.query(
          "select a.ends_at, pt.recall_months from appointments a join procedure_types pt on pt.id = a.procedure_type_id where a.id = $1",
          [run.subject_id],
        )
      ).rows[0];
      if (!a) return null;
      return {
        language,
        params: [name, clinic.name, String(a.recall_months)],
        buttons: [`recall_book:${run.subject_id}`],
      };
    }
    case "aftercare": {
      const a = (
        await client.query(
          "select pt.name, pt.name_hi, pt.aftercare from appointments a join procedure_types pt on pt.id = a.procedure_type_id where a.id = $1",
          [run.subject_id],
        )
      ).rows[0];
      const care = a?.aftercare;
      // Only wording a doctor has approved is ever sent.
      if (!care?.approved) return null;
      const text = (care[language] || care.en || care.hi) as string | undefined;
      if (!text) return null;
      return {
        language,
        params: [name, clinic.name, language === "hi" && a.name_hi ? a.name_hi : a.name, text],
        appointmentId: run.subject_id,
      };
    }
    case "checkin": {
      const a = (
        await client.query(
          "select pt.name, pt.name_hi, pt.checkin from appointments a join procedure_types pt on pt.id = a.procedure_type_id where a.id = $1",
          [run.subject_id],
        )
      ).rows[0];
      if (!a?.checkin) return null;
      return {
        language,
        params: [name, clinic.name, language === "hi" && a.name_hi ? a.name_hi : a.name],
        buttons: [
          `checkin:${run.subject_id}:ok`,
          `checkin:${run.subject_id}:pain`,
          `checkin:${run.subject_id}:help`,
        ],
        appointmentId: run.subject_id,
      };
    }
    case "lead_welcome":
    case "lead_nudge":
    case "lead_checkin": {
      const l = (await client.query("select name, need, answers from leads where id = $1", [run.subject_id]))
        .rows[0];
      if (!l) return null;
      // Write in the language the lead used on the form; otherwise the clinic's usual language.
      const said = Object.entries((l.answers ?? {}) as Record<string, string>)
        .filter(([k]) => !["full_name", "first_name", "last_name", "phone_number", "email"].includes(k))
        .map(([, v]) => v)
        .join(" ");
      if (/[\u0900-\u097F]/.test(said)) language = "hi";
      else if (/[a-z]{3,}/i.test(said)) language = "en";
      const words = {
        en: {
          pain: "treatment for your tooth problem",
          implant: "dental implants",
          braces: "braces and aligners",
          rct: "root canal treatment",
          cleaning: "a check-up and cleaning",
          cosmetic: "a brighter smile",
          major: "braces, implants or smile work",
        },
        hi: {
          pain: "दाँत की तकलीफ़ के इलाज",
          implant: "डेंटल इम्प्लांट",
          braces: "ब्रेसेस और एलाइनर",
          rct: "रूट कैनाल इलाज",
          cleaning: "जाँच और सफ़ाई",
          cosmetic: "सुंदर मुस्कान",
          major: "ब्रेसेस, इम्प्लांट या मुस्कान के इलाज",
        },
      }[language] as Record<string, string>;
      return {
        language,
        params: [
          l.name?.split(" ")[0] || (language === "hi" ? "जी" : "there"),
          clinic.name,
          words[l.need] ?? (language === "hi" ? "दाँतों के इलाज" : "dental care"),
        ],
        buttons: [`lead:${run.subject_id}:book`, `lead:${run.subject_id}:ask`, `lead:${run.subject_id}:call`],
      };
    }
    case "dues_reminder": {
      const l = (
        await client.query(
          `select l.url, l.amount_paise from payment_links l
           where l.patient_id = $1 and l.purpose = 'dues' and l.status = 'created'
             and l.amount_paise = (select balance_paise from patient_balances b where b.patient_id = $1)
             and l.created_at > now() - interval '10 days'
           order by l.created_at desc limit 1`,
          [run.patient_id],
        )
      ).rows[0];
      if (!l) return null;
      return {
        language,
        params: [name, clinic.name, formatINR(Number(l.amount_paise) as Paise), l.url],
        buttons: [`callme:${run.id}`],
      };
    }
    default:
      return null;
  }
}

const TASK_TITLES: Record<FollowupKind, [kind: string, title: string]> = {
  treatment_continuity: ["followup", "Treatment not continued"],
  estimate: ["followup", "Estimate not answered"],
  no_show: ["followup", "Missed appointment, not rebooked"],
  unconfirmed: ["unconfirmed", "Appointment not confirmed"],
  recall: ["followup", "Recall due, no response"],
  aftercare_checkin: ["followup", "After-care check"],
  dues: ["followup", "Payment due, not received"],
  lead: ["lead", "Lead to call"],
};

async function staffTask(client: PoolClient, run: RunRow, now: Date): Promise<string | null> {
  const [kind, title] = TASK_TITLES[run.kind];
  const appointmentId = ["no_show", "unconfirmed", "recall", "aftercare_checkin"].includes(run.kind)
    ? run.subject_id
    : null;
  const { rows } = await client.query(
    `insert into tasks (clinic_id, kind, priority, title, detail, patient_id, appointment_id, due_at, created_by, dedupe_key)
     values (app.current_clinic_id(), $1, 'normal', $2, $3, $4, $5, $6, 'followup', $7)
     on conflict (clinic_id, dedupe_key) do nothing returning id`,
    [
      kind,
      `${title}: ${run.patient_name}`,
      `Please call ${run.phone ?? "the patient"}.`,
      run.patient_id,
      appointmentId,
      now,
      `followup:${run.id}:${run.step}`,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Active and recent follow-ups for the dashboard. */
export async function listFollowups(
  client: PoolClient,
  filter: { status?: "active" | "finished"; kind?: FollowupKind; limit?: number } = {},
) {
  const { rows } = await client.query(
    `select r.id, r.kind, r.subject_type, r.subject_id, r.step, r.next_at, r.status, r.stop_reason, r.started_at, r.finished_at,
            r.patient_id, coalesce(p.name, l.name) as patient_name, coalesce(p.phone, r.phone) as phone,
            (select count(*)::int from followup_actions a where a.run_id = r.id) as actions
     from followup_runs r left join patients p on p.id = r.patient_id
     left join leads l on r.subject_type = 'lead' and l.id = r.subject_id
     where ($1::text is null or ($1 = 'active' and r.status = 'active') or ($1 = 'finished' and r.status <> 'active'))
       and ($2::text is null or r.kind = $2)
     order by case when r.status = 'active' then 0 else 1 end, r.next_at limit $3`,
    [filter.status ?? null, filter.kind ?? null, filter.limit ?? 100],
  );
  return rows;
}

export async function getLadders(client: PoolClient) {
  const custom = new Map(
    (await client.query("select kind, steps, active from followup_ladders")).rows.map((r) => [r.kind, r]),
  );
  return (Object.keys(DEFAULT_LADDERS) as FollowupKind[]).map((kind) => ({
    kind,
    steps: (custom.get(kind)?.steps as LadderStep[] | undefined) ?? DEFAULT_LADDERS[kind],
    active: custom.get(kind)?.active ?? true,
    custom: custom.has(kind),
  }));
}

export async function saveLadder(
  client: PoolClient,
  kind: FollowupKind,
  steps: LadderStep[],
  active: boolean,
) {
  await client.query(
    `insert into followup_ladders (clinic_id, kind, steps, active) values (app.current_clinic_id(), $1, $2, $3)
     on conflict (clinic_id, kind) do update set steps = excluded.steps, active = excluded.active`,
    [kind, JSON.stringify(steps), active],
  );
}

import type { PoolClient } from "pg";
import { DomainError } from "../errors";
import { bookDirect, loadBusy, setAppointmentStatus } from "../scheduling/service";
import { addDays, localDateOf, zonedInstant, type LocalDate } from "../time";

/**
 * The front desk's day (reception workflow): one queue of everyone at the clinic, with a token each.
 * Booked patients join it when they arrive (a database trigger, whoever marks them); walk-ins are added
 * here. A walk-in gets an appointment only when the doctor is ready for them, fitted into the time free
 * before the doctor's next booked patient, so walk-ins never push booked patients out.
 */

export type QueueStatus = "waiting" | "with_doctor" | "done" | "left";

async function clinicTimezone(client: PoolClient): Promise<string> {
  return (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
}

export async function listQueue(client: PoolClient, day: LocalDate) {
  const { rows } = await client.query(
    `select q.id, q.token, q.status, q.arrived_at, q.called_at, q.finished_at, q.note, q.appointment_id,
            q.patient_id, p.name as patient_name, p.phone as patient_phone,
            coalesce(a.doctor_id, q.doctor_id) as doctor_id, d.name as doctor_name,
            coalesce(a.procedure_type_id, q.procedure_type_id) as procedure_type_id, pt.name as procedure_name,
            pt.name_hi as procedure_name_hi, a.starts_at as booked_for, a.source as appointment_source
     from queue_entries q
     join patients p on p.id = q.patient_id
     left join appointments a on a.id = q.appointment_id
     left join doctors d on d.id = coalesce(a.doctor_id, q.doctor_id)
     left join procedure_types pt on pt.id = coalesce(a.procedure_type_id, q.procedure_type_id)
     where q.day = $1
     order by q.token`,
    [day],
  );
  return rows.map((r) => ({
    id: r.id as string,
    token: r.token as number,
    status: r.status as QueueStatus,
    arrivedAt: r.arrived_at as Date,
    calledAt: r.called_at as Date | null,
    finishedAt: r.finished_at as Date | null,
    note: r.note as string | null,
    appointmentId: r.appointment_id as string | null,
    walkIn: !r.booked_for || r.appointment_source === "walk_in",
    bookedFor: r.appointment_source === "walk_in" ? null : (r.booked_for as Date | null),
    patient: {
      id: r.patient_id as string,
      name: r.patient_name as string,
      phone: r.patient_phone as string | null,
    },
    doctor: r.doctor_id ? { id: r.doctor_id as string, name: r.doctor_name as string } : null,
    procedure: r.procedure_type_id
      ? {
          id: r.procedure_type_id as string,
          name: r.procedure_name as string,
          nameHi: r.procedure_name_hi as string | null,
        }
      : null,
  }));
}

/** A walk-in joins the queue with the next token. The same patient can't be waiting twice. */
export async function addWalkIn(
  client: PoolClient,
  input: {
    patientId: string;
    doctorId?: string | null;
    procedureTypeId?: string | null;
    note?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const day = localDateOf(now, await clinicTimezone(client));
  const already = await client.query(
    "select token from queue_entries where day = $1 and patient_id = $2 and status in ('waiting', 'with_doctor')",
    [day, input.patientId],
  );
  if (already.rowCount)
    throw new DomainError("conflict", `Already in the queue with token ${already.rows[0].token}`);
  const { rows } = await client.query(
    `insert into queue_entries (clinic_id, day, token, patient_id, doctor_id, procedure_type_id, note, arrived_at)
     values (app.current_clinic_id(), $1, app.next_token(app.current_clinic_id(), $1), $2, $3, $4, $5, $6)
     returning id, token`,
    [
      day,
      input.patientId,
      input.doctorId ?? null,
      input.procedureTypeId ?? null,
      input.note?.trim() || null,
      now,
    ],
  );
  return { id: rows[0].id as string, token: rows[0].token as number };
}

const MIN_WALK_IN_MIN = 5;
const DEFAULT_WALK_IN_MIN = 15;

/**
 * The doctor is ready: a walk-in gets an appointment from now, as long as the treatment needs, but never
 * past the doctor's or chair's next booking. A booked patient simply goes in.
 */
export async function sendIn(
  client: PoolClient,
  entryId: string,
  input: { doctorId?: string; chairId?: string; userId?: string; now?: Date },
) {
  const entry = (await client.query("select * from queue_entries where id = $1 for update", [entryId]))
    .rows[0];
  if (!entry) throw new DomainError("not_found", "Not in the queue");
  if (entry.status !== "waiting") throw new DomainError("invalid", "This patient is not waiting");
  if (entry.appointment_id) {
    await setAppointmentStatus(client, entry.appointment_id, "in_chair");
    return { appointmentId: entry.appointment_id as string };
  }
  const doctorId = input.doctorId ?? entry.doctor_id;
  if (!doctorId || !input.chairId) throw new DomainError("invalid", "Choose the doctor and the chair");
  const now = new Date(Math.floor((input.now ?? new Date()).getTime() / 60_000) * 60_000);
  const procedure = entry.procedure_type_id
    ? (
        await client.query(
          "select default_duration_min, buffer_after_min from procedure_types where id = $1",
          [entry.procedure_type_id],
        )
      ).rows[0]
    : null;
  const wanted = (procedure?.default_duration_min ?? DEFAULT_WALK_IN_MIN) as number;
  const buffer = (procedure?.buffer_after_min ?? 0) as number;
  const horizon = new Date(now.getTime() + (wanted + buffer) * 60_000);
  const busy = (await loadBusy(client, now, horizon)).filter(
    (b) => b.resourceId === doctorId || b.resourceId === input.chairId,
  );
  if (busy.some((b) => b.start <= now)) {
    const who = busy.some((b) => b.start <= now && b.resourceId === doctorId) ? "doctor" : "chair";
    throw new DomainError(
      "slot_taken",
      who === "doctor" ? "The doctor is busy right now" : "That chair is busy right now",
      {
        busy: who,
      },
    );
  }
  const nextBusy = busy.reduce<Date | null>((m, b) => (!m || b.start < m ? b.start : m), null);
  const latestEnd = nextBusy ? new Date(nextBusy.getTime() - buffer * 60_000) : null;
  let endsAt = new Date(now.getTime() + wanted * 60_000);
  if (latestEnd && latestEnd < endsAt) endsAt = latestEnd;
  if (endsAt.getTime() - now.getTime() < MIN_WALK_IN_MIN * 60_000)
    throw new DomainError(
      "slot_taken",
      "A booked patient is due in a few minutes; choose another doctor or chair",
      {
        busy: "next",
      },
    );

  const { appointment } = await bookDirect(client, {
    patientId: entry.patient_id,
    doctorId,
    chairId: input.chairId,
    procedureTypeId: entry.procedure_type_id,
    startsAt: now,
    endsAt,
    source: "walk_in",
    notes: entry.note ?? undefined,
    bookedByUserId: input.userId,
    acknowledgeWarnings: true,
    idempotencyKey: `walk-in:${entryId}`,
    now,
  });
  await client.query("update queue_entries set appointment_id = $2 where id = $1", [entryId, appointment.id]);
  await setAppointmentStatus(client, appointment.id, "in_chair");
  return { appointmentId: appointment.id };
}

/** A walk-in who left without being seen. */
export async function leaveQueue(client: PoolClient, entryId: string) {
  const { rowCount } = await client.query(
    "update queue_entries set status = 'left', finished_at = now() where id = $1 and status = 'waiting' and appointment_id is null",
    [entryId],
  );
  if (!rowCount) throw new DomainError("invalid", "Only a waiting walk-in can be marked as left");
}

/** What the assistant did today, in plain numbers, for the top of the Today screen. */
export async function assistantToday(client: PoolClient, day: LocalDate) {
  const tz = await clinicTimezone(client);
  const from = zonedInstant(day, 0, tz);
  const to = zonedInstant(addDays(day, 1), 0, tz);
  const r = (
    await client.query(
      `select
         (select count(*) from calls where started_at >= $1 and started_at < $2 and direction = 'inbound'
            and route = 'assistant' and not is_test)::int as calls,
         (select count(*) from appointments where created_at >= $1 and created_at < $2
            and source in ('whatsapp', 'voice'))::int as booked,
         (select count(distinct conversation_id) from messages where created_at >= $1 and created_at < $2
            and direction = 'out' and author = 'bot')::int as chats,
         (select count(*) from outbox where sent_at >= $1 and sent_at < $2 and status = 'sent'
            and (purpose like 'reminder%' or purpose like 'followup%' or purpose like 'confirm%'))::int as reminders,
         (select count(*) from calls where started_at >= $1 and started_at < $2 and outcome = 'emergency')::int as emergencies`,
      [from, to],
    )
  ).rows[0];
  return {
    calls: r.calls as number,
    booked: r.booked as number,
    chats: r.chats as number,
    reminders: r.reminders as number,
    emergencies: r.emergencies as number,
  };
}

/** Billed and paid for each of the day's visits, so the desk sees who still has to pay before leaving. */
export async function visitBilling(client: PoolClient, appointmentIds: string[]) {
  if (!appointmentIds.length) return {};
  const { rows } = await client.query(
    `select appointment_id,
            coalesce(sum(amount_paise) filter (where kind = 'charge'), 0)::bigint as charged,
            coalesce(sum(amount_paise) filter (where kind = 'payment'), 0)::bigint as paid
     from patient_ledger l
     where appointment_id = any($1::uuid[])
       and reverses_id is null and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)
     group by appointment_id`,
    [appointmentIds],
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.appointment_id as string,
      { chargedPaise: Number(r.charged), paidPaise: Number(r.paid) },
    ]),
  ) as Record<string, { chargedPaise: number; paidPaise: number }>;
}

/** Badges for the side menu: what needs someone now. */
export async function deskCounts(client: PoolClient) {
  const r = (
    await client.query(
      `select
         (select count(*) from tasks where status = 'open')::int as tasks,
         (select count(*) from tasks where status = 'open' and priority = 'critical')::int as critical,
         (select coalesce(sum(unread_count), 0) from conversations)::int as unread,
         (select count(*) from tasks where status = 'open' and kind = 'lead')::int as leads`,
    )
  ).rows[0];
  return {
    tasks: r.tasks as number,
    critical: r.critical as number,
    unread: r.unread as number,
    leads: r.leads as number,
  };
}

/**
 * Everything the desk needs to settle a visit: this visit's charges and payments, what the patient owed
 * before, and suggested lines (the sitting's price from the plan, else the treatment's price) so the
 * receptionist only confirms the amount.
 */
export async function visitCheckout(client: PoolClient, appointmentId: string) {
  const a = (
    await client.query(
      `select a.id, a.status, a.starts_at, a.patient_id, p.name as patient_name, p.phone as patient_phone,
              d.name as doctor_name, a.procedure_type_id, pt.name as procedure_name,
              pt.price_min_paise, pt.price_max_paise, s.value_paise as step_value, s.id as step_id
       from appointments a join patients p on p.id = a.patient_id join doctors d on d.id = a.doctor_id
       left join procedure_types pt on pt.id = a.procedure_type_id
       left join treatment_steps s on s.id = a.treatment_step_id
       where a.id = $1`,
      [appointmentId],
    )
  ).rows[0];
  if (!a) throw new DomainError("not_found", "Appointment not found");
  const entries = (
    await client.query(
      `select id, kind, amount_paise, method, description, created_at,
              (select r.id from receipts r where r.ledger_id = l.id and r.cancelled_at is null limit 1) as receipt_id
       from patient_ledger l
       where appointment_id = $1 and reverses_id is null
         and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)
       order by created_at`,
      [appointmentId],
    )
  ).rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    amountPaise: Number(r.amount_paise),
    method: r.method as string | null,
    description: r.description as string,
    receiptId: r.receipt_id as string | null,
  }));
  const balance = Number(
    (
      await client.query(
        "select coalesce(sum(balance_paise), 0)::bigint as b from patient_balances where patient_id = $1",
        [a.patient_id],
      )
    ).rows[0].b,
  );
  const charged = entries.filter((e) => e.kind === "charge").reduce((s, e) => s + e.amountPaise, 0);
  const paid = entries.filter((e) => e.kind === "payment").reduce((s, e) => s + e.amountPaise, 0);
  const price =
    a.step_value && Number(a.step_value) > 0
      ? Number(a.step_value)
      : a.price_min_paise && a.price_min_paise === a.price_max_paise
        ? Number(a.price_min_paise)
        : a.price_min_paise
          ? Number(a.price_min_paise)
          : null;
  const nextSitting = (
    await client.query(
      `select s.id, pt.name, s.expected_from, s.expected_to
       from treatment_steps s join treatment_plans pl on pl.id = s.plan_id
       join procedure_types pt on pt.id = s.procedure_type_id
       where pl.patient_id = $1 and s.status = 'pending' and pl.status in ('accepted', 'in_progress')
       order by s.expected_from nulls last, s.seq limit 1`,
      [a.patient_id],
    )
  ).rows[0];
  return {
    appointment: {
      id: a.id as string,
      status: a.status as string,
      startsAt: a.starts_at as Date,
      doctorName: a.doctor_name as string,
      procedureName: a.procedure_name as string | null,
    },
    patient: {
      id: a.patient_id as string,
      name: a.patient_name as string,
      phone: a.patient_phone as string | null,
    },
    entries,
    chargedPaise: charged,
    paidPaise: paid,
    balancePaise: balance,
    suggested:
      charged === 0 && a.procedure_type_id
        ? [
            {
              procedureTypeId: a.procedure_type_id as string,
              treatmentStepId: (a.step_id as string | null) ?? null,
              description: a.procedure_name as string,
              amountPaise: price,
              priceRange:
                a.price_min_paise && a.price_max_paise && a.price_min_paise !== a.price_max_paise
                  ? { min: Number(a.price_min_paise), max: Number(a.price_max_paise) }
                  : null,
            },
          ]
        : [],
    nextSitting: nextSitting
      ? {
          id: nextSitting.id as string,
          name: nextSitting.name as string,
          from: nextSitting.expected_from as string | null,
          to: nextSitting.expected_to as string | null,
        }
      : null,
  };
}

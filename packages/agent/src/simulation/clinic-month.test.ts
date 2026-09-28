import { FakeMessagingProvider, FakeStorageProvider, type MessagingEvent } from "@dentalos/adapters";
import {
  addDays,
  advanceFollowups,
  approveCampaign,
  bookDirect,
  createCampaign,
  createEstimate,
  createPatient,
  createTreatmentPlan,
  decideEstimate,
  getWhatsAppChannel,
  incompleteTreatments,
  localDateOf,
  localMinutesOf,
  MemoryJobQueue,
  patientPlans,
  planAppointmentMessages,
  planFollowups,
  processOutbox,
  recordMarketingConsent,
  registerStandardTemplates,
  runCampaign,
  sendEstimate,
  setAppointmentStatus,
  submitCampaign,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupWhatsAppClinic } from "../testing/harness";
import { processInboundMessage } from "../whatsapp/inbound";
import { ingestMessagingEvents } from "../whatsapp/webhook";

/**
 * PLAN Phase 4 acceptance: a simulated 30-day clinic.
 *
 * About 300 patients in cohorts (treatment plans, recalls, no-shows, estimates, upcoming appointments, a
 * reactivation campaign, quiet patients), a fake clock that moves hour by hour through March 2030, and
 * scripted patient behaviour (booking, confirming, accepting, ignoring, and sending STOP through the real
 * WhatsApp assistant). Every hour the real planners, the follow-up stepper and the outbox run.
 *
 * Checks: the full schedule of follow-ups and messages matches the golden file exactly; nothing is sent to
 * a patient after they opt out; nothing goes out outside the allowed hours; the incomplete-treatment totals
 * match a figure computed by hand from the scenario below.
 */
const TZ = "Asia/Kolkata";
const START: LocalDate = "2030-03-01";
const DAYS = 30;
const at = (date: LocalDate, hhmm: string) =>
  zonedInstant(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ);

// Prices (paise) set on the clinic so every sitting has a known value.
const PRICES: Record<string, number> = {
  rct_sitting: 400000,
  crown_prep: 500000,
  crown_fitting: 500000,
  extraction: 150000,
  followup: 30000,
  implant_surgery: 2500000,
  implant_followup: 100000,
  ortho_consultation: 50000,
  ortho_adjustment: 150000,
  scaling: 120000,
};
// Sittings of each template, for the hand-computed totals.
const TEMPLATE_STEPS: Record<string, string[]> = {
  rct_crown: ["rct_sitting", "rct_sitting", "rct_sitting", "crown_prep", "crown_fitting"],
  rct: ["rct_sitting", "rct_sitting", "rct_sitting"],
  extraction: ["extraction", "followup"],
  implant: ["implant_surgery", "implant_followup", "crown_prep", "crown_fitting"],
  braces: ["ortho_consultation", ...Array<string>(12).fill("ortho_adjustment")],
};
const TEMPLATE_CYCLE = ["rct_crown", "rct", "extraction", "implant", "braces"];

interface ScriptedEvent {
  at: Date;
  label: string;
  run: () => Promise<void>;
}

describe.skipIf(!hasTestDatabase)("simulated 30-day clinic (Phase 4 acceptance)", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  let ownerUserId: string;
  const messaging = new FakeMessagingProvider();
  const jobs = new MemoryJobQueue();
  const storage = new FakeStorageProvider();
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, fn);

  const labelOf = new Map<string, string>(); // phone → "P017"
  const log: { at: Date; line: string }[] = [];
  const optedOutAt = new Map<string, Date>(); // phone → when STOP was processed
  const events: ScriptedEvent[] = [];
  let expectedRemainingPaise = 0;
  let expectedPlans = 0;

  // One doctor/chair pair per column; 16 half-hour slots per working day.
  const SLOT_TIMES = [
    "10:00",
    "10:30",
    "11:00",
    "11:30",
    "12:00",
    "12:30",
    "13:00",
    "13:30",
    "17:00",
    "17:30",
    "18:00",
    "18:30",
    "19:00",
    "19:30",
    "20:00",
    "20:30",
  ];
  const used = new Map<string, number>();
  let doctors: string[] = [];
  let chairs: string[] = [];
  function slot(date: LocalDate): { start: Date; doctorId: string; chairId: string } {
    let d = date;
    while (weekdayOf(d) === 0) d = addDays(d, 1);
    for (;;) {
      const n = used.get(d) ?? 0;
      if (n < SLOT_TIMES.length * 2) {
        used.set(d, n + 1);
        return {
          start: at(d, SLOT_TIMES[Math.floor(n / 2)]!),
          doctorId: doctors[n % 2]!,
          chairId: chairs[n % 2]!,
        };
      }
      d = addDays(d, 1);
      while (weekdayOf(d) === 0) d = addDays(d, 1);
    }
  }
  async function book(
    c: PoolClient,
    patientId: string,
    date: LocalDate,
    procedure: string,
    extra: { step?: string; createdAt?: Date } = {},
  ) {
    const s = slot(date);
    const proc = (await c.query("select id from procedure_types where code = $1", [procedure])).rows[0].id;
    const { appointment } = await bookDirect(c, {
      patientId,
      doctorId: s.doctorId,
      chairId: s.chairId,
      procedureTypeId: proc,
      startsAt: s.start,
      // 15-minute visits: the longest clean-up buffer (15 min) still fits in a half-hour slot.
      endsAt: new Date(s.start.getTime() + 15 * 60_000),
      acknowledgeWarnings: true,
      treatmentStepId: extra.step,
    });
    // Bookings made before the month were confirmed back then; bookings during the month get their
    // confirmation from the real planner.
    if (extra.createdAt)
      await c.query(
        "update appointments set created_at = $2, notified_starts_at = case when $3 then starts_at end where id = $1",
        [appointment.id, extra.createdAt, extra.createdAt < at(START, "00:00")],
      );
    return appointment;
  }

  /** A patient's WhatsApp message, through the real webhook intake and assistant. */
  async function patientSays(phone: string, text: string, now: Date) {
    const event: MessagingEvent = {
      type: "inbound_message",
      eventId: `sim:${phone}:${now.getTime()}`,
      providerMessageId: `wamid.sim.${phone}.${now.getTime()}`,
      from: phone,
      channelId: "109876543210",
      at: now,
      content: { kind: "text", text },
    };
    await ingestMessagingEvents(db.pool, jobs, [event]);
    for (const job of jobs.take("process_inbound"))
      await processInboundMessage(
        { pool: db.pool, jobs, messaging, now: () => now },
        String(job.payload.clinicId),
        String(job.payload.messageId),
      );
    jobs.take("send_outbox");
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupWhatsAppClinic(db.pool, "Month Dental");
    ownerUserId = (
      await db.pool.query(
        "insert into users (id, name, phone) values (gen_random_uuid(), 'Owner', '+919835000001') returning id",
      )
    ).rows[0].id;
    await run(async (c) => {
      await registerStandardTemplates(c);
      await c.query("update message_templates set meta_status = 'approved'");
      for (const [code, paise] of Object.entries(PRICES))
        await c.query(
          "update procedure_types set price_min_paise = $2, price_max_paise = $2 where code = $1",
          [code, paise],
        );
      await c.query(
        "insert into doctors (clinic_id, name, phone) values (app.current_clinic_id(), 'Dr. Verma', '+919835000002')",
      );
      await c.query(
        "insert into chairs (clinic_id, branch_id, name) values (app.current_clinic_id(), (select id from branches limit 1), 'Chair 2')",
      );
      await c.query(
        "insert into clinic_channels (clinic_id, kind, external_id, display_phone) values (app.current_clinic_id(), 'voice', '+918047117777', '+918047117777')",
      );
      await c.query(`update clinics set settings = settings || '{"voice": {"outboundFlowId": "1"}}'`);
      doctors = (await c.query("select id from doctors order by name")).rows.map((r) => r.id);
      chairs = (await c.query("select id from chairs order by name")).rows.map((r) => r.id);
    });

    // ---------------------------------------------------------------- the scenario
    const patients = await run(async (c) => {
      const out: { id: string; phone: string; label: string }[] = [];
      for (let i = 0; i < 300; i++) {
        const label = `P${String(i).padStart(3, "0")}`;
        const phone = `+91980000${String(1000 + i)}`;
        const p = await createPatient(c, { name: label, phone, languagePref: i % 2 ? "hi" : "en" });
        labelOf.set(phone, label);
        out.push({ id: p.id, phone, label });
      }
      return out;
    });
    const before = at("2030-02-25", "12:00");

    await run(async (c) => {
      const templates = new Map(
        (await c.query("select id, code from treatment_templates")).rows.map((r) => [
          r.code as string,
          r.id as string,
        ]),
      );

      // A. 60 accepted treatment plans starting in March.
      for (let i = 0; i < 60; i++) {
        const p = patients[i]!;
        const code = TEMPLATE_CYCLE[i % TEMPLATE_CYCLE.length]!;
        const startDate = addDays(START, 1 + (i % 20));
        const plan = await createTreatmentPlan(c, {
          patientId: p.id,
          templateId: templates.get(code)!,
          startDate,
          status: "accepted",
          now: before,
        });
        const steps = (await patientPlans(c, p.id))[0]!.steps;
        let completed = 0;
        if (i % 3 !== 0) {
          // Staff booked the first sitting at the last visit; it is done (or missed) on the day.
          const a = await book(
            c,
            p.id,
            startDate,
            steps[0]!.procedure === "Root canal (RCT) sitting" ? "rct_sitting" : TEMPLATE_STEPS[code]![0]!,
            { step: steps[0]!.id, createdAt: before },
          );
          const missed = i % 10 === 7;
          if (!missed) completed = 1;
          events.push({
            at: a.endsAt,
            label: `${p.label} ${missed ? "no-show" : "completes sitting 1"}`,
            run: () =>
              run((cc) => setAppointmentStatus(cc, a.id, missed ? "no_show" : "completed")).then(
                () => undefined,
              ),
          });
        }
        void plan;
        // Patient behaviour on the next-sitting reminder is scripted in onContinuity below.
        expectedPlans++;
        const values = TEMPLATE_STEPS[code]!.map((s) => PRICES[s]!);
        expectedRemainingPaise += values.slice(completed).reduce((a, b) => a + b, 0);
      }

      // B. 40 recalls: cleaning six months ago.
      for (let i = 60; i < 100; i++) {
        const p = patients[i]!;
        const a = await book(c, p.id, addDays("2029-09-02", i % 26), "scaling", {
          createdAt: at("2029-08-25", "10:00"),
        });
        await setAppointmentStatus(c, a.id, "completed");
      }

      // C. 30 no-shows in March.
      for (let i = 100; i < 130; i++) {
        const p = patients[i]!;
        const a = await book(c, p.id, addDays(START, 1 + (i % 25)), "filling", { createdAt: before });
        events.push({
          at: a.endsAt,
          label: `${p.label} no-show`,
          run: () => run((cc) => setAppointmentStatus(cc, a.id, "no_show")).then(() => undefined),
        });
      }

      // E. 60 upcoming appointments booked in February (reminders, confirmation calls, check-ins).
      for (let i = 160; i < 220; i++) {
        const p = patients[i]!;
        const a = await book(
          c,
          p.id,
          addDays(START, 2 + (i % 26)),
          i % 5 === 0 ? "extraction" : "consultation",
          { createdAt: before },
        );
        // Some confirm from the day-before reminder; others are left to the confirmation call.
        if (i % 3 === 2) {
          const dayBefore = addDays(localDateOf(a.startsAt, TZ), -1);
          events.push({
            at: at(dayBefore, "17:30"),
            label: `${p.label} taps Confirm`,
            run: () => run((cc) => setAppointmentStatus(cc, a.id, "confirmed")).then(() => undefined),
          });
        }
        events.push({
          at: a.endsAt,
          label: `${p.label} visit done`,
          run: () => run((cc) => setAppointmentStatus(cc, a.id, "completed")).then(() => undefined),
        });
      }

      // F. Quiet patients; every tenth agreed to offers and last came a year ago (campaign audience).
      for (let i = 220; i < 300; i++) {
        const p = patients[i]!;
        if (i % 10 !== 0) continue;
        const a = await book(c, p.id, addDays("2029-02-05", i % 20), "consultation", {
          createdAt: at("2029-02-01", "10:00"),
        });
        await setAppointmentStatus(c, a.id, "completed");
        await recordMarketingConsent(c, { phone: p.phone, patientId: p.id, granted: true, via: "staff" });
        if (i % 20 === 0)
          await c.query(
            "insert into opt_outs (clinic_id, phone, channel, category, source) values (app.current_clinic_id(), $1, 'all', 'promotional', 'desk')",
            [p.phone],
          );
      }
    });

    // D. 30 estimates sent through March (by staff, at noon).
    for (let i = 130; i < 160; i++) {
      const p = patients[i]!;
      const when = at(addDays(START, i % 25), "12:00");
      events.push({
        at: when,
        label: `${p.label} gets an estimate`,
        run: async () => {
          const e = await run((c) =>
            createEstimate(c, {
              patientId: p.id,
              items: [{ label: "Crown", qty: 1, amountPaise: 1000000 }],
              now: when,
            }),
          );
          await run((c) => sendEstimate(c, e.id, { storage, now: when }));
          if (i % 4 === 0)
            events.push({
              at: new Date(when.getTime() + 3 * 86_400_000),
              label: `${p.label} accepts the estimate`,
              run: () => run((c) => decideEstimate(c, e.id, "accepted")),
            });
          if (i % 5 === 2 && i % 4 !== 0)
            events.push({
              at: new Date(when.getTime() + 86_400_000),
              label: `${p.label} declines the estimate`,
              run: () => run((c) => decideEstimate(c, e.id, "declined")),
            });
        },
      });
    }

    // The owner runs a reactivation campaign on 15 March at 08:00 (messages wait for 09:00).
    events.push({
      at: at("2030-03-15", "08:00"),
      label: "campaign",
      run: async () => {
        const { id } = await run((c) =>
          createCampaign(c, {
            name: "Check-ups",
            inactiveMonths: 12,
            offerText: "We are open on Sundays in March, 10 am to 1 pm.",
          }),
        );
        await run((c) => submitCampaign(c, id));
        await run((c) => approveCampaign(c, id, ownerUserId));
        await run((c) => runCampaign(c, id, at("2030-03-15", "08:00")));
      },
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** Scripted replies to follow-up messages, keyed by the message the patient received. */
  async function reactTo(sent: { phone: string; purpose: string; at: Date }) {
    const label = labelOf.get(sent.phone);
    if (!label) return;
    const i = Number(label.slice(1));
    const patient = (await db.pool.query("select id from patients where phone = $1", [sent.phone])).rows[0]
      .id as string;
    const later = (hours: number) => new Date(sent.at.getTime() + hours * 3600_000);
    if (sent.purpose === "treatment_next_sitting") {
      if (i % 6 === 5)
        events.push({
          at: later(2),
          label: `${label} sends STOP`,
          run: () => patientSays(sent.phone, "STOP", later(2)),
        });
      else if (i % 4 === 1)
        events.push({
          at: later(24),
          label: `${label} books the next sitting`,
          run: async () => {
            await run(async (c) => {
              const plans = await patientPlans(c, patient);
              const next = plans[0]!.steps.find((s) => s.status === "pending" || s.status === "missed");
              if (next) {
                const code = (
                  await c.query("select code from procedure_types where id = $1", [next.procedureTypeId])
                ).rows[0].code;
                await book(c, patient, addDays(localDateOf(later(24), TZ), 2), code, {
                  step: next.id,
                  createdAt: later(24),
                });
              }
            });
          },
        });
    }
    if (sent.purpose === "recall") {
      if (i % 7 === 3)
        events.push({
          at: later(3),
          label: `${label} sends STOP`,
          run: () => patientSays(sent.phone, "STOP", later(3)),
        });
      else if (i % 5 === 0)
        events.push({
          at: later(48),
          label: `${label} books a check-up`,
          run: () =>
            run((c) =>
              book(c, patient, addDays(localDateOf(later(48), TZ), 3), "consultation", {
                createdAt: later(48),
              }),
            ).then(() => undefined),
        });
    }
    if (sent.purpose === "no_show" && i % 3 === 0)
      events.push({
        at: later(20),
        label: `${label} rebooks`,
        run: () =>
          run((c) =>
            book(c, patient, addDays(localDateOf(later(20), TZ), 2), "filling", { createdAt: later(20) }),
          ).then(() => undefined),
      });
  }

  it("runs the month and matches the golden schedule, with no sends after opt-out or outside hours", async () => {
    const clockStart = at(START, "00:00");
    const channel = (c: PoolClient) => getWhatsAppChannel(c, clinic.key);
    for (let h = 0; h < DAYS * 24; h++) {
      const now = new Date(clockStart.getTime() + h * 3600_000);
      // Scripted events due by now, in order.
      events.sort((a, b) => a.at.getTime() - b.at.getTime() || a.label.localeCompare(b.label));
      while (events.length && events[0]!.at <= now) await events.shift()!.run();

      await run((c) => planAppointmentMessages(c, now));
      await run((c) => planFollowups(c, now));
      const stepped = await run((c) => advanceFollowups(c, now));
      for (const call of stepped.calls) {
        if (call.purpose !== "confirm_appointment") continue;
        // Confirmation calls: every other patient answers and confirms; the rest don't pick up.
        const appt = (
          await db.pool.query("select patient_id from appointments where id = $1", [call.appointmentId])
        ).rows[0];
        const phone = (await db.pool.query("select phone from patients where id = $1", [appt.patient_id]))
          .rows[0].phone;
        const i = Number(labelOf.get(phone)!.slice(1));
        log.push({
          at: now,
          line: `${labelOf.get(phone)} ai_call ${i % 2 === 0 ? "answered: confirmed" : "no answer"}`,
        });
        if (i % 2 === 0) await run((c) => setAppointmentStatus(c, call.appointmentId, "confirmed"));
      }

      // The outbox, as the worker would run it this hour.
      const due = (
        await db.pool.query(
          "select id from outbox where clinic_id = $1 and status = 'pending' and not_before <= $2 order by not_before, created_at, id",
          [clinic.clinicId, now],
        )
      ).rows;
      for (const { id } of due) {
        const row = (
          await db.pool.query("select to_phone, payload, category, purpose from outbox where id = $1", [id])
        ).rows[0];
        const outcome = await run((c) => processOutbox(c, id, { messaging, channel, now: () => now }));
        const purpose = row.payload.kind === "template" ? row.payload.purpose : row.purpose;
        const who = labelOf.get(row.to_phone) ?? "staff";
        if (outcome.status === "sent") {
          log.push({ at: now, line: `${who} whatsapp ${purpose} [${row.category}]` });
          await reactTo({ phone: row.to_phone, purpose, at: now });
          // Opt-out is honoured from the moment it is processed: only the confirmation reply may follow.
          const optedOut = optedOutAt.get(row.to_phone);
          if (optedOut && row.category !== "service" && row.category !== "critical")
            throw new Error(`${who} got ${purpose} after opting out at ${optedOut.toISOString()}`);
          const minutes = localMinutesOf(now, TZ);
          if (row.category === "transactional")
            expect(
              minutes >= 7 * 60 && minutes < 21 * 60 + 30,
              `${who} ${purpose} at ${now.toISOString()}`,
            ).toBe(true);
          if (row.category === "promotional")
            expect(minutes >= 9 * 60 && minutes < 20 * 60, `${who} ${purpose} at ${now.toISOString()}`).toBe(
              true,
            );
        } else if (outcome.status === "blocked") {
          log.push({ at: now, line: `${who} blocked ${purpose} (${outcome.reason})` });
        }
      }
      // Record opt-outs as they happen.
      for (const r of (
        await db.pool.query(
          "select phone from opt_outs where clinic_id = $1 and revoked_at is null and source = 'whatsapp_stop'",
          [clinic.clinicId],
        )
      ).rows)
        if (!optedOutAt.has(r.phone)) optedOutAt.set(r.phone, now);
    }

    // Follow-up actions (messages, calls, staff tasks) with the step that caused them.
    const actions = (
      await db.pool.query(
        `select a.at, a.action, a.result, r.kind, p.name from followup_actions a join followup_runs r on r.id = a.run_id
           join patients p on p.id = r.patient_id where a.clinic_id = $1`,
        [clinic.clinicId],
      )
    ).rows;
    for (const a of actions) log.push({ at: a.at, line: `${a.name} step ${a.kind} ${a.action} ${a.result}` });
    const runs = (
      await db.pool.query(
        `select r.kind, r.status, count(*)::int as n from followup_runs r where r.clinic_id = $1 group by 1, 2 order by 1, 2`,
        [clinic.clinicId],
      )
    ).rows;

    const fmt = (d: Date) =>
      `${localDateOf(d, TZ).slice(5)} ${String(Math.floor(localMinutesOf(d, TZ) / 60)).padStart(2, "0")}:${String(localMinutesOf(d, TZ) % 60).padStart(2, "0")}`;
    const lines = log.map((l) => `${fmt(l.at)}  ${l.line}`).sort();
    const summary = runs.map((r) => `${r.kind} ${r.status}: ${r.n}`);
    await expect([...summary, "", ...lines].join("\n") + "\n").toMatchFileSnapshot(
      "./__golden__/clinic-month.txt",
    );

    // Every opted-out patient's follow-ups stopped.
    expect(optedOutAt.size).toBeGreaterThan(0);
    for (const phone of optedOutAt.keys()) {
      const active = await db.pool.query(
        "select count(*)::int as n from followup_runs where phone = $1 and status = 'active'",
        [phone],
      );
      expect(active.rows[0].n, labelOf.get(phone)).toBe(0);
    }
    // Something of every kind happened.
    const kinds = new Set(actions.map((a) => a.kind));
    expect([...kinds].sort()).toEqual([
      "aftercare_checkin",
      "estimate",
      "no_show",
      "recall",
      "treatment_continuity",
      "unconfirmed",
    ]);

    // Incomplete treatments at the end of the month vs. the scenario, computed by hand above (plus the
    // sittings booked-and-completed during the month, which the scenario does not complete: no
    // second sittings are marked done, so the hand figure holds).
    const incomplete = await run((c) => incompleteTreatments(c, at("2030-03-31", "23:00")));
    expect(incomplete.totals.plans).toBe(expectedPlans);
    expect(incomplete.totals.remainingPaise).toBe(expectedRemainingPaise);
  }, 300_000);
});

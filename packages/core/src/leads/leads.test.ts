import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordPayment } from "../billing/ledger";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import { advanceFollowups } from "../revenue/followups";
import { bookDirect, setAppointmentStatus } from "../scheduling/service";
import { randomBytes } from "node:crypto";
import { FakeLeadAdsProvider } from "@dentalos/adapters";
import { connectMetaDataset, connectMetaPage, leadSettings } from "./channels";
import {
  createLead,
  leadDetail,
  leadFromForm,
  leadFunnel,
  leadReplied,
  leadWhatsAppFailed,
  listLeads,
  needFromText,
  nextCallTime,
  qualifyLead,
  recordCallOutcome,
  scoreLead,
  syncLeads,
  timingFromText,
} from "./leads";
import { sendLeadSignals } from "./signals";

// Monday 7 January 2030.
const MON_11 = new Date("2030-01-07T11:00:00+05:30");
const MON_22 = new Date("2030-01-07T22:00:00+05:30");

describe("reading and scoring leads", () => {
  it("understands what the lead wants and when", () => {
    expect(needFromText("I have tooth pain since 2 days")).toBe("pain");
    expect(needFromText("dant mein dard")).toBe("pain");
    expect(needFromText("Want to fix missing teeth")).toBe("implant");
    expect(needFromText("aligners")).toBe("braces");
    expect(needFromText("general question")).toBeNull();
    expect(timingFromText("This week")).toBe("week");
    expect(timingFromText("Just exploring")).toBe("exploring");
  });

  it("hot = pain or soon or high value; cold = only exploring", () => {
    expect(scoreLead("pain", "exploring")).toBe("hot");
    expect(scoreLead("cleaning", "week")).toBe("hot");
    expect(scoreLead("implant", null)).toBe("hot");
    expect(scoreLead("implant", "exploring")).toBe("cold");
    expect(scoreLead("cleaning", "month")).toBe("warm");
  });

  it("maps a Meta lead form, keeping the form's own questions", () => {
    const l = leadFromForm({
      leadgenId: "1",
      createdAt: new Date(),
      fields: [
        { name: "full_name", values: ["Priya Kumari"] },
        { name: "phone_number", values: ["+919876543210"] },
        { name: "which_treatment?", values: ["Braces / aligners"] },
        { name: "when_would_you_like_to_visit?", values: ["This week"] },
      ],
    });
    expect(l).toMatchObject({ name: "Priya Kumari", phone: "+919876543210", need: "braces", timing: "week" });
    expect(l.answers["which_treatment?"]).toBe("Braces / aligners");
  });
});

describe.skipIf(!hasTestDatabase)("leads", () => {
  let db: TestDatabase;
  let clinicId: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "system" }, fn);
  let n = 0;
  const phone = () => `+9190090${String(10000 + ++n)}`;

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Leads Dental",
        owner: { name: "Dr. L", phone: "9835000121" },
      }));
      const branch = (await client.query("select id from branches where clinic_id = $1", [clinicId])).rows[0]
        .id;
      for (let wd = 1; wd <= 6; wd++)
        await client.query(
          "insert into working_hours (clinic_id, branch_id, weekday, start_time, end_time) values ($1, $2, $3, '10:00', '14:00'), ($1, $2, $3, '17:00', '21:00')",
          [clinicId, branch, wd],
        );
      await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. L')", [clinicId]);
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("calls are due within clinic hours: now when open, else at the next opening", async () => {
    expect(await run((c) => nextCallTime(c, MON_11))).toEqual(MON_11);
    expect(await run((c) => nextCallTime(c, MON_22))).toEqual(new Date("2030-01-08T10:00:00+05:30"));
    expect(await run((c) => nextCallTime(c, new Date("2030-01-07T15:00:00+05:30")))).toEqual(
      new Date("2030-01-07T17:00:00+05:30"),
    );
  });

  it("a new lead: recorded once, first WhatsApp at once, hot → a person calls within 15 minutes", async () => {
    const p = phone();
    const a = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-1",
        phone: p,
        name: "Priya Kumari",
        need: "implant",
        answers: { "which_treatment?": "Implant for a missing tooth" },
        campaign: "Implants Jan",
        now: MON_11,
      }),
    );
    expect(a.created).toBe(true);
    // Meta retries the webhook; the same person also fills another form the next day.
    expect(
      await run((c) => createLead(c, { source: "meta_form", externalId: "lg-1", phone: p, now: MON_11 })),
    ).toEqual({ id: a.id, created: false });
    expect(
      (
        await run((c) =>
          createLead(c, {
            source: "meta_form",
            externalId: "lg-2",
            phone: p,
            now: new Date(MON_11.getTime() + 86_400_000),
          }),
        )
      ).id,
    ).toBe(a.id);

    const task = await run(
      async (c) =>
        (await c.query("select priority, title, detail, due_at from tasks where lead_id = $1", [a.id])).rows,
    );
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ priority: "high", title: "Hot lead: call now: Priya Kumari" });
    expect(task[0].detail).toContain("Implants Jan");
    expect(task[0].due_at).toEqual(new Date(MON_11.getTime() + 15 * 60_000));

    const stepped = await run((c) => advanceFollowups(c, MON_11));
    expect(stepped.messages).toBeGreaterThanOrEqual(1);
    const msg = await run(
      async (c) => (await c.query("select category, payload from outbox where to_phone = $1", [p])).rows[0],
    );
    expect(msg.payload).toMatchObject({
      purpose: "lead_welcome",
      params: ["Priya", "Leads Dental", "dental implants"],
      buttonPayloads: [`lead:${a.id}:book`, `lead:${a.id}:ask`, `lead:${a.id}:call`],
    });
    const lead = (await run((c) => leadDetail(c, a.id))).lead;
    expect(lead).toMatchObject({ stage: "contacted", score: "hot" });
    expect(lead.first_contact_at).toEqual(MON_11);
  });

  it("qualifying: answers change the score; a warm lead turning hot gets a call task", async () => {
    const p = phone();
    const { id } = await run((c) =>
      createLead(c, { source: "website", phone: p, name: "Amit", now: MON_11 }),
    );
    expect((await run((c) => leadDetail(c, id))).lead.score).toBe("warm");
    await run((c) => leadReplied(c, p, MON_11));
    expect(await run((c) => qualifyLead(c, id, { need: "cleaning", timing: "week" }, MON_11))).toEqual({
      score: "hot",
    });
    const d = await run((c) => leadDetail(c, id));
    expect(d.lead.stage).toBe("qualified");
    expect(d.activities.map((x) => x.kind)).toEqual(["created", "replied", "qualified", "call_task"]);
  });

  it("call outcomes: call back later schedules a task; not interested closes the lead and its follow-up", async () => {
    const p = phone();
    const { id } = await run((c) =>
      createLead(c, { source: "justdial", phone: p, name: "Neha", now: MON_11 }),
    );
    const later = new Date("2030-01-08T18:00:00+05:30");
    await run((c) =>
      recordCallOutcome(c, id, {
        outcome: "callback",
        callbackAt: later,
        note: "At work, call evening",
        now: MON_11,
      }),
    );
    const tasks = await run(
      async (c) =>
        (await c.query("select status, due_at from tasks where lead_id = $1 order by created_at", [id])).rows,
    );
    expect(tasks.at(-1)).toEqual({ status: "open", due_at: later });
    await run((c) => recordCallOutcome(c, id, { outcome: "not_interested", note: "Too far", now: MON_11 }));
    const d = await run((c) => leadDetail(c, id));
    expect(d.lead).toMatchObject({ stage: "lost", lost_reason: "Too far" });
    expect(
      (
        await run(
          async (c) =>
            (await c.query("select status from followup_runs where subject_id = $1", [id])).rows[0],
        )
      ).status,
    ).toBe("stopped_staff");
    expect(
      await run(
        async (c) =>
          (await c.query("select count(*)::int as n from tasks where lead_id = $1 and status = 'open'", [id]))
            .rows[0].n,
      ),
    ).toBe(0);
  });

  it("stages follow the clinic: booked, visited, won with the amount paid", async () => {
    const p = phone();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-9",
        phone: p,
        name: "Kiran",
        campaign: "RCT",
        now: MON_11,
      }),
    );
    const appt = await run(async (c) => {
      const pt = await createPatient(c, { name: "Kiran", phone: p });
      const doctor = (await c.query("select id from doctors limit 1")).rows[0].id;
      const chair = (await c.query("select id from chairs limit 1")).rows[0].id;
      return (
        await bookDirect(c, {
          patientId: pt.id,
          doctorId: doctor,
          chairId: chair,
          startsAt: new Date("2030-01-09T11:00:00+05:30"),
          endsAt: new Date("2030-01-09T11:30:00+05:30"),
          acknowledgeWarnings: true,
          now: MON_11,
        })
      ).appointment;
    });
    // Booked on the (simulated) day the lead came in.
    await db.pool.query("update appointments set created_at = $2 where id = $1", [appt.id, MON_11]);
    await run((c) => syncLeads(c, MON_11));
    expect((await run((c) => leadDetail(c, id))).lead.stage).toBe("booked");
    await run((c) => setAppointmentStatus(c, appt.id, "completed"));
    await run((c) => syncLeads(c, MON_11));
    expect((await run((c) => leadDetail(c, id))).lead.stage).toBe("visited");
    await run((c) =>
      recordPayment(c, {
        patientId: appt.patientId,
        amountPaise: 450000,
        method: "upi",
        now: new Date(MON_11.getTime() + 2 * 86_400_000),
      }),
    );
    await run((c) => syncLeads(c, MON_11));
    expect((await run((c) => leadDetail(c, id))).lead).toMatchObject({
      stage: "won",
      won_value_paise: 450000,
    });
    // Its follow-up stops by itself.
    await run((c) => advanceFollowups(c, new Date(MON_11.getTime() + 4 * 3600_000)));
    expect(
      (
        await run(
          async (c) =>
            (await c.query("select status from followup_runs where subject_id = $1", [id])).rows[0],
        )
      ).status,
    ).toBe("stopped_success");
  });

  it("a lead that never answers: nudges, calls, two later check-ins, then closed as unresponsive; the funnel adds up", async () => {
    const p = phone();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-20",
        phone: p,
        name: "Silent",
        need: "cleaning",
        timing: "month",
        now: MON_11,
      }),
    );
    for (let h = 0; h <= 28 * 24; h += 2)
      await run((c) => advanceFollowups(c, new Date(MON_11.getTime() + h * 3600_000)));
    // Still open while the check-ins run; closed only when the ladder is done.
    await run((c) => syncLeads(c, new Date(MON_11.getTime() + 29 * 86_400_000)));
    const d = await run((c) => leadDetail(c, id));
    expect(d.lead.stage).toBe("unresponsive");
    const sent = await run(
      async (c) =>
        (
          await c.query(
            "select payload->>'purpose' as p from outbox where to_phone = $1 order by created_at",
            [p],
          )
        ).rows,
    );
    expect(sent.map((r) => r.p)).toEqual([
      "lead_welcome",
      "lead_nudge",
      "lead_nudge",
      "lead_checkin",
      "lead_checkin",
    ]);
    const calls = await run(
      async (c) =>
        (await c.query("select title from tasks where lead_id = $1 order by created_at", [id])).rows,
    );
    expect(calls.map((r) => r.title.split(":")[0])).toEqual(["New lead has not booked", "Last try"]);

    const f = await run((c) => leadFunnel(c, { from: new Date("2030-01-01"), to: new Date("2030-02-01") }));
    expect(f.totals.leads).toBeGreaterThanOrEqual(5);
    expect(f.totals.won).toBe(1);
    expect(f.totals.revenuePaise).toBe(450000);
    expect(f.channels.find((c) => c.channel === "RCT")).toMatchObject({ leads: 1, booked: 1, won: 1 });
    const open = await run((c) => listLeads(c, { stage: "open" }));
    expect(open.every((l) => ["new", "contacted", "engaged", "qualified"].includes(l.stage))).toBe(true);
  }, 120_000);

  it("WhatsApp can't reach the lead: a person is asked to call at once, once", async () => {
    const p = phone();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-30",
        phone: p,
        name: "No WA",
        need: "cleaning",
        timing: "month",
        now: MON_11,
      }),
    );
    expect(await run((c) => leadWhatsAppFailed(c, { phone: p, errorCode: "131026", now: MON_11 }))).toBe(1);
    expect(await run((c) => leadWhatsAppFailed(c, { phone: p, errorCode: "131026", now: MON_11 }))).toBe(0);
    const tasks = await run(
      async (c) => (await c.query("select priority, title from tasks where lead_id = $1", [id])).rows,
    );
    expect(tasks).toEqual([{ priority: "high", title: "Not on WhatsApp: call this lead: No WA" }]);
    expect((await run((c) => leadDetail(c, id))).activities.map((a) => a.kind)).toContain("unreachable");
    // Someone who has already replied on WhatsApp is reachable; a later failure is not a reason to call.
    const q = phone();
    await run((c) => createLead(c, { source: "website", phone: q, name: "Talks", now: MON_11 }));
    await run((c) => leadReplied(c, q, MON_11));
    expect(await run((c) => leadWhatsAppFailed(c, { phone: q, now: MON_11 }))).toBe(0);
  });

  it("tells Meta which ad leads were qualified, booked, came in and paid; once each, only with a dataset", async () => {
    const key = randomBytes(32);
    const leads = new FakeLeadAdsProvider();
    const later = new Date(MON_11.getTime() + 3 * 86_400_000);
    const ctwa = await run((c) =>
      createLead(c, {
        source: "ctwa",
        externalId: "ARAkLkA8rmlF",
        phone: phone(),
        name: "Ad Chat",
        alreadyTalking: true,
        now: MON_11,
      }),
    );
    await run((c) => qualifyLead(c, ctwa.id, { need: "braces", timing: "week" }, MON_11));
    const noClick = await run((c) =>
      createLead(c, {
        source: "ctwa",
        externalId: "wamid.HBgM",
        phone: phone(),
        name: "Old App",
        alreadyTalking: true,
        now: MON_11,
      }),
    );
    await run((c) => qualifyLead(c, noClick.id, { need: "cleaning", timing: "week" }, MON_11));

    // No dataset yet: nothing is sent, but nothing is lost either.
    expect(await run((c) => sendLeadSignals(c, { key, leads, now: later }))).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    await run((c) =>
      connectMetaPage(c, key, { pageId: "444444444", pageAccessToken: "page-token-0123456789abcdef" }),
    );
    await run((c) =>
      connectMetaDataset(c, key, { datasetId: "777000111", accessToken: "capi-token-0123456789abcdef" }),
    );
    // Re-saving the Page token keeps the dataset.
    await run((c) =>
      connectMetaPage(c, key, { pageId: "444444444", pageAccessToken: "page-token-new-0123456789" }),
    );

    const first = await run((c) => sendLeadSignals(c, { key, leads, now: later }));
    expect(first).toEqual({ sent: 4, skipped: 1, failed: 0 });
    expect(leads.conversions).toHaveLength(1);
    expect(leads.conversions[0]).toMatchObject({
      datasetId: "777000111",
      accessToken: "capi-token-0123456789abcdef",
    });
    const events = leads.conversions[0]!.events;
    expect(events.filter((e) => e.kind === "crm").map((e) => [e.eventName, e.leadId, e.valuePaise])).toEqual([
      ["booked", "lg-9", undefined],
      ["visited", "lg-9", undefined],
      ["won", "lg-9", 450000],
    ]);
    expect(events.find((e) => e.kind === "whatsapp")).toMatchObject({
      eventName: "Lead",
      ctwaClid: "ARAkLkA8rmlF",
      pageId: "444444444",
      eventId: `${ctwa.id}:qualified`,
    });
    expect(events.every((e) => e.hashedPhone?.length === 64)).toBe(true);

    // Nothing twice; Meta refusing is recorded and shown in settings.
    expect(await run((c) => sendLeadSignals(c, { key, leads, now: later }))).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    const settings = await run((c) => leadSettings(c, key));
    expect(settings).toMatchObject({ datasetId: "777000111", signals: { sent: 4, failed: 0 } });
    expect(JSON.stringify(settings)).not.toContain("capi-token");

    // An event older than Meta's 7-day limit is skipped, not sent.
    const late = await run((c) =>
      createLead(c, { source: "meta_form", externalId: "lg-40", phone: phone(), name: "Late", now: MON_11 }),
    );
    await run((c) => qualifyLead(c, late.id, { need: "rct", timing: "month" }, MON_11));
    expect(
      await run((c) => sendLeadSignals(c, { key, leads, now: new Date(MON_11.getTime() + 9 * 86_400_000) })),
    ).toEqual({
      sent: 0,
      skipped: 1,
      failed: 0,
    });
  });
});

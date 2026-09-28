import {
  advanceFollowups,
  createLead,
  ensureConversation,
  leadDetail,
  logMessage,
  registerStandardTemplates,
} from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_ID, lastButtons, PatientSimulator, setupWhatsAppClinic } from "../testing/harness";

// Monday 7 January 2030, 11:00 IST.
const NOW = new Date("2030-01-07T11:00:00+05:30");
const text = (m: { kind: string } & Record<string, unknown>) => String(m.text ?? m.body ?? "");

/**
 * Phase 6: leads from ads, on WhatsApp. The assistant answers at once, asks two tap-questions and books a
 * consultation; people get the call tasks for hot leads and anyone who asks for a call.
 */
describe.skipIf(!hasTestDatabase)("leads on WhatsApp", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  let n = 0;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "system" }, fn);
  const person = () => new PatientSimulator(db.pool, clinic, `+9190095${String(10000 + ++n)}`, new Date(NOW));
  const tasksFor = (leadId: string) =>
    run(
      async (c) =>
        (await c.query("select title, status from tasks where lead_id = $1 order by created_at", [leadId]))
          .rows,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupWhatsAppClinic(db.pool, "Lead Dental");
    await run(async (c) => {
      await registerStandardTemplates(c);
      await c.query("update message_templates set meta_status = 'approved'");
    });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("a form lead: welcome at once, two taps, times offered, booked with the form's name; call task closed", async () => {
    const p = person();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-100",
        phone: p.phone,
        name: "priya kumari",
        campaign: "Braces Jan",
        now: NOW,
      }),
    );
    await run((c) => advanceFollowups(c, NOW));
    expect((await run((c) => leadDetail(c, id))).lead.stage).toBe("contacted");

    const q1 = await p.tap(`lead:${id}:book`, "Book a visit");
    expect(text(q1.at(-1)!)).toMatch(/What would you like help with|madad|मदद/);
    expect(lastButtons(q1).map((b) => b.id)).toEqual([
      `lead_need:${id}:pain`,
      `lead_need:${id}:major`,
      `lead_need:${id}:checkup`,
    ]);
    const q2 = await p.tap(`lead_need:${id}:major`, "Braces/implants");
    expect(lastButtons(q2).map((b) => b.id)).toEqual([
      `lead_when:${id}:week`,
      `lead_when:${id}:month`,
      `lead_when:${id}:exploring`,
    ]);

    // "Braces or implants" is high value: a person is asked to call even before a time is chosen.
    expect((await tasksFor(id)).map((t) => t.title)).toEqual(["Hot lead: call now: priya kumari"]);

    const offered = await p.tap(`lead_when:${id}:week`, "This week");
    const slots = lastButtons(offered);
    expect(slots).toHaveLength(3);
    const readBack = await p.tap(slots[0]!.id, slots[0]!.title);
    expect(text(readBack.at(-1)!)).toContain("Priya Kumari");
    await p.tap("yes_book", "Yes, book it");

    const d = await run((c) => leadDetail(c, id));
    expect(d.lead).toMatchObject({ stage: "booked", need: "major", timing: "week", score: "hot" });
    expect(d.lead.appointment_id).toBeTruthy();
    expect((await tasksFor(id)).every((t) => t.status === "done")).toBe(true);
    const patient = (await db.pool.query("select name from patients where phone = $1", [p.phone])).rows[0];
    expect(patient.name).toBe("Priya Kumari");
    // Tapping our message counts as agreeing to be contacted, with the notice shown for information.
    const consent = (await db.pool.query("select captured_via from consents where phone = $1", [p.phone]))
      .rows[0];
    expect(consent.captured_via).toBe("lead_reply");
  });

  it("'Just exploring' is not pushed; 'Call me' asks a person; STOP closes the lead and its tasks", async () => {
    const p = person();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-101",
        phone: p.phone,
        name: "Amit",
        need: "cleaning",
        now: NOW,
      }),
    );
    const q2 = await p.tap(`lead:${id}:book`, "Book a visit");
    expect(lastButtons(q2)[0]!.id).toBe(`lead_when:${id}:week`); // need known from the form: only "when"
    const exploring = await p.tap(`lead_when:${id}:exploring`, "Just exploring");
    expect(lastButtons(exploring).map((b) => b.id)).toEqual([`lead:${id}:book`]);
    expect((await run((c) => leadDetail(c, id))).lead.score).toBe("cold");

    await p.tap(`lead:${id}:call`, "Call me");
    expect((await tasksFor(id)).map((t) => t.title)).toEqual(["Lead asked for a call: Amit"]);
    await p.say("STOP");
    expect((await run((c) => leadDetail(c, id))).lead).toMatchObject({
      stage: "lost",
      lost_reason: "Sent STOP",
    });
    expect((await tasksFor(id)).every((t) => t.status === "cancelled")).toBe(true);
  });

  it("a lead's button can't be used from another phone", async () => {
    const owner = person();
    const { id } = await run((c) =>
      createLead(c, { source: "website", phone: owner.phone, name: "Real Lead", now: NOW }),
    );
    const other = person();
    await other.tap(`lead:${id}:call`, "Call me");
    expect(await tasksFor(id)).toEqual([]);
  });

  it("Click-to-WhatsApp: the first message from an ad creates a lead that is already talking", async () => {
    const p = person();
    await p.deliver([
      {
        type: "inbound_message",
        eventId: "msg:ctwa-1",
        providerMessageId: "wamid.ctwa1",
        from: p.phone,
        profileName: "Sunita",
        channelId: CHANNEL_ID,
        at: NOW,
        content: { kind: "text", text: "Hi, I want to know about implants" },
        referral: {
          sourceType: "ad",
          sourceId: "120210000000001",
          headline: "Implants in Ranchi",
          ctwaClid: "ctwa-abc",
        },
      },
    ]);
    const lead = (
      await db.pool.query(
        "select id, source, stage, name, need, campaign, first_contact_at from leads where phone = $1",
        [p.phone],
      )
    ).rows[0];
    expect(lead).toMatchObject({
      source: "ctwa",
      stage: "engaged",
      name: "Sunita",
      need: "implant",
      campaign: "Implants in Ranchi",
    });
    expect(lead.first_contact_at).toEqual(NOW);
    // Implants: a person is asked to call.
    expect((await tasksFor(lead.id)).map((t) => t.title)).toEqual(["Hot lead: call now: Sunita"]);
    // They wrote first, so the assistant answers them now (consent notice first); no welcome template.
    expect(p.transcript().join(" ")).toMatch(/Agree|सहमत/);
    const templates = (
      await db.pool.query(
        "select 1 from outbox where to_phone = $1 and payload->>'purpose' = 'lead_welcome'",
        [p.phone],
      )
    ).rowCount;
    expect(templates).toBe(0);
  });

  it("WhatsApp reports our welcome undeliverable (not on WhatsApp): a person is asked to call at once", async () => {
    const p = person();
    const { id } = await run((c) =>
      createLead(c, {
        source: "meta_form",
        externalId: "lg-110",
        phone: p.phone,
        name: "Landline Only",
        need: "cleaning",
        timing: "month",
        now: NOW,
      }),
    );
    await run(async (c) => {
      const conv = await ensureConversation(c, p.phone);
      await logMessage(c, {
        conversationId: conv.id,
        direction: "out",
        author: "system",
        kind: "template",
        body: "Welcome",
        providerMessageId: "wamid.fail1",
        status: "sent",
      });
    });
    expect(await tasksFor(id)).toEqual([]);
    await p.deliver([
      {
        type: "status",
        eventId: "status:fail1",
        channelId: CHANNEL_ID,
        providerMessageId: "wamid.fail1",
        status: "failed",
        errorCode: "131026",
        at: NOW,
      },
    ]);
    expect(await tasksFor(id)).toEqual([
      { title: "Not on WhatsApp: call this lead: Landline Only", status: "open" },
    ]);
  });
});

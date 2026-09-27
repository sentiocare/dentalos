import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import {
  approveCampaign,
  campaignAudience,
  cancelCampaign,
  checkPromotionalText,
  createCampaign,
  recordMarketingConsent,
  runCampaign,
  submitCampaign,
} from "./campaigns";

const NOW = new Date("2031-01-15T10:00:00+05:30");

describe("promotional wording check", () => {
  it.each([
    ["Get the best smile in Ranchi!", "superlatives or guarantees"],
    ["100% painless root canal", "superlatives or guarantees"],
    ["Hurry, offer ends today only", "urgency"],
    ["Free RCT this month", "discounts on treatment"],
    ["Our whitening cures sensitivity", "medical claims"],
  ])("%s", (text, why) => {
    expect(checkPromotionalText(text)).toContain(why);
  });

  it("allows plain, factual wording", () => {
    expect(
      checkPromotionalText("We are open on Sundays in January, 10 am to 2 pm. A check-up takes 15 minutes."),
    ).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)("reactivation campaigns", () => {
  let db: TestDatabase;
  let clinicId: string;
  let ownerId: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);
  let n = 0;
  async function pastPatient(
    name: string,
    lastVisit: string,
    opts: { consent?: boolean; optOut?: boolean; upcoming?: boolean } = {},
  ) {
    const phone = `+9190007${String(10000 + ++n)}`;
    await run(async (c) => {
      const p = await createPatient(c, { name, phone });
      const doctor = (await c.query("select id from doctors limit 1")).rows[0].id;
      const chair = (await c.query("select id from chairs limit 1")).rows[0].id;
      const branch = (await c.query("select id from branches limit 1")).rows[0].id;
      const ins = (start: string, status: string) =>
        c.query(
          `insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at, status)
           values (app.current_clinic_id(), $1, $2, $3, $4, $5::timestamptz + make_interval(mins => $7),
                   $5::timestamptz + make_interval(mins => $7 + 30), $6)`,
          [branch, p.id, doctor, chair, start, status, n * 40],
        );
      await ins(lastVisit, "completed");
      if (opts.upcoming) await ins("2031-02-01T11:00:00+05:30", "booked");
      if (opts.consent !== undefined)
        await recordMarketingConsent(c, { phone, patientId: p.id, granted: opts.consent, via: "staff" });
      if (opts.optOut)
        await c.query(
          "insert into opt_outs (clinic_id, phone, channel, category, source) values (app.current_clinic_id(), $1, 'whatsapp', 'promotional', 'test')",
          [phone],
        );
    });
    return phone;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Campaign Dental",
        owner: { name: "Dr. C", phone: "9835000081" },
      }));
      await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. C')", [clinicId]);
      ownerId = (
        await client.query(
          "insert into users (id, name, phone) values (gen_random_uuid(), 'Owner', '+919835000081') returning id",
        )
      ).rows[0].id;
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("targets inactive patients with marketing consent only, once per phone; needs owner approval", async () => {
    const yes = await pastPatient("Old Consenting", "2029-06-01T11:00:00+05:30", { consent: true });
    await pastPatient("Old No Consent", "2029-06-01T11:00:00+05:30");
    await pastPatient("Old Said No", "2029-06-01T11:00:00+05:30", { consent: false });
    await pastPatient("Old Opted Out", "2029-06-01T11:00:00+05:30", { consent: true, optOut: true });
    await pastPatient("Recent", "2030-12-01T11:00:00+05:30", { consent: true });
    await pastPatient("Old But Booked", "2029-06-01T11:00:00+05:30", { consent: true, upcoming: true });

    const audience = await run((c) => campaignAudience(c, 12, NOW));
    expect(audience.eligible.map((e) => e.phone)).toEqual([yes]);
    expect(audience).toMatchObject({ noConsent: 2, optedOut: 1 });

    const bad = await run((c) =>
      createCampaign(c, { name: "Bad", inactiveMonths: 12, offerText: "Best clinic, hurry!" }),
    );
    expect(bad.problems.length).toBeGreaterThan(0);
    await expect(run((c) => submitCampaign(c, bad.id))).rejects.toThrow(/change the message/);

    const { id } = await run((c) =>
      createCampaign(c, {
        name: "January check-ups",
        inactiveMonths: 12,
        offerText: "We are open on Sundays this month.",
      }),
    );
    await expect(run((c) => runCampaign(c, id, NOW))).rejects.toThrow(/owner must approve/);
    await run((c) => submitCampaign(c, id));
    await run((c) => approveCampaign(c, id, ownerId));
    const stats = await run((c) => runCampaign(c, id, NOW));
    expect(stats).toEqual({ queued: 1, noConsent: 2, optedOut: 1 });
    const msg = (
      await db.pool.query("select to_phone, category, payload from outbox where dedupe_key like $1", [
        `campaign:${id}:%`,
      ])
    ).rows;
    expect(msg).toEqual([
      {
        to_phone: yes,
        category: "promotional",
        payload: expect.objectContaining({ purpose: "reactivation" }),
      },
    ]);
    await expect(run((c) => cancelCampaign(c, id))).rejects.toThrow(/finished/);
  });
});

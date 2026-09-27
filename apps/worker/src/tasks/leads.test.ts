import { createAdapters, FakeLeadAdsProvider } from "@dentalos/adapters";
import { connectMetaPage, createClinic, registerStandardTemplates } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import type { JobHelpers } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFetchLeadTask } from "./leads";

describe.skipIf(!hasTestDatabase)("fetch_lead job", () => {
  let db: TestDatabase;
  let clinicId: string;
  const key = Buffer.alloc(32, 5);
  const adapters = createAdapters({
    messaging: "fake",
    telephony: "fake",
    voice: "fake",
    llm: "fake",
    payments: "fake",
    sms: "fake",
    storage: "fake",
  });
  const leads = adapters.leads as FakeLeadAdsProvider;
  const added: { task: string; payload: unknown }[] = [];
  const helpers = {
    addJob: async (task: string, payload: unknown) => void added.push({ task, payload }),
  } as unknown as JobHelpers;

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Fetch Dental",
        owner: { name: "Dr. F", phone: "9835000141" },
      }));
    } finally {
      client.release();
    }
    await withClinic(db.pool, { clinicId, actor: "system", role: "system" }, async (c) => {
      await registerStandardTemplates(c);
      await connectMetaPage(c, key, { pageId: "555555555", pageAccessToken: "EAAB-page-token-for-tests-1" });
    });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("fetches the answers with the clinic's Page token, records the lead and queues the first WhatsApp at once", async () => {
    leads.leads.set("7001", {
      leadgenId: "7001",
      createdAt: new Date(),
      campaignName: "Braces Sept",
      adName: "Braces video",
      fields: [
        { name: "full_name", values: ["Meena Singh"] },
        { name: "phone_number", values: ["+919876544444"] },
        { name: "what_are_you_looking_for?", values: ["Braces for my daughter"] },
      ],
    });
    const task = makeFetchLeadTask({
      pool: db.pool,
      adapters,
      channelKey: key,
      logger: createLogger({ service: "t", level: "silent" }),
    });
    await task({ clinicId, leadgenId: "7001" }, helpers);
    await task({ clinicId, leadgenId: "7001" }, helpers); // a retried job changes nothing
    expect(leads.fetched[0]).toEqual({ token: "EAAB-page-token-for-tests-1", leadgenId: "7001" });
    const rows = (
      await db.pool.query(
        "select name, source, campaign, need, stage, first_contact_at from leads where clinic_id = $1",
        [clinicId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Meena Singh",
      source: "meta_form",
      campaign: "Braces Sept",
      need: "braces",
      stage: "contacted",
    });
    const welcome = (
      await db.pool.query(
        "select id from outbox where to_phone = '+919876544444' and payload->>'purpose' = 'lead_welcome'",
      )
    ).rows;
    expect(welcome).toHaveLength(1);
    expect(
      added.some(
        (j) => j.task === "send_outbox" && (j.payload as { outboxId: string }).outboxId === welcome[0].id,
      ),
    ).toBe(true);
  });
});

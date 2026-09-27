import { FakeMessagingProvider, FakePaymentProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { enqueueMessage, processOutbox } from "../comms/outbox";
import { registerStandardTemplates } from "../comms/templates";
import { createPatient } from "../patients/service";
import { approveCampaign, createCampaign, runCampaign, submitCampaign } from "../revenue/campaigns";
import { meter, meterCall, price, rateFor } from "./metering";
import { walletAllows, walletNotices, walletStatus, type Capability, type WalletState } from "./wallet";

describe("what each wallet state allows (PLAN §5.6)", () => {
  const states: WalletState[] = ["active", "low", "grace", "suspended"];
  // Rows: capability; columns: active, low, grace, suspended.
  const table: [Capability, boolean[]][] = [
    ["ai_inbound_call", [true, true, false, false]],
    ["ai_chat", [true, true, false, false]],
    ["emergency", [true, true, true, true]],
    ["critical_message", [true, true, true, true]],
    ["service_message", [true, true, true, true]],
    ["transactional_message", [true, true, true, false]],
    ["campaign", [true, true, false, false]],
    ["recall", [true, true, false, false]],
    ["ai_outbound_call", [true, true, false, false]],
    ["promotional_message", [true, true, false, false]],
    ["owner_notice", [true, true, true, true]],
  ];
  it.each(table)("%s", (cap, expected) => {
    expect(states.map((state) => walletAllows({ enforced: true, state, capReached: false }, cap))).toEqual(
      expected,
    );
  });

  it("the monthly limit pauses optional spend only", () => {
    const s = { enforced: true, state: "active" as const, capReached: true };
    expect(walletAllows(s, "campaign")).toBe(false);
    expect(walletAllows(s, "recall")).toBe(false);
    expect(walletAllows(s, "ai_outbound_call")).toBe(false);
    expect(walletAllows(s, "ai_inbound_call")).toBe(true);
    expect(walletAllows(s, "transactional_message")).toBe(true);
  });

  it("nothing is paused before Sentio switches billing on for a clinic", () => {
    for (const [cap] of table)
      expect(walletAllows({ enforced: false, state: "suspended", capReached: true }, cap)).toBe(true);
  });

  it("prices: provider cost plus margin, rounded to the paisa", () => {
    expect(price({ providerCostPaise: 60, marginPct: 50, marginPaise: 0 }, 3)).toEqual({
      providerCostPaise: 180,
      marginPaise: 90,
      totalPaise: 270,
    });
    expect(price({ providerCostPaise: 0.025, marginPct: 50, marginPaise: 0 }, 1234)).toEqual({
      providerCostPaise: 30.85,
      marginPaise: 15.425,
      totalPaise: 46,
    });
  });
});

describe.skipIf(!hasTestDatabase)("wallet and metering", () => {
  let db: TestDatabase;
  let clinicId: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "system" }, fn);
  const messaging = new FakeMessagingProvider();
  const payments = new FakePaymentProvider();
  const channel = async () => ({ channelId: "pn-1", accessToken: "t" });
  const NOW = new Date("2030-05-10T11:00:00+05:30");

  /** Sets the balance exactly (as Sentio's admin would with an adjustment) and turns billing on. */
  const setBalance = async (paise: number) => {
    const cur = Number(
      (await db.pool.query("select balance_paise from wallets where clinic_id = $1", [clinicId])).rows[0]
        .balance_paise,
    );
    if (paise !== cur)
      await db.pool.query(
        "insert into wallet_credits (clinic_id, kind, amount_paise, note) values ($1, 'adjustment', $2, 'test')",
        [clinicId, paise - cur],
      );
    await db.pool.query("update wallets set enforced = true where clinic_id = $1", [clinicId]);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Wallet Dental",
        owner: { name: "Dr. W", phone: "9835000091" },
      }));
    } finally {
      client.release();
    }
    await run(async (c) => {
      await registerStandardTemplates(c);
      await c.query("update message_templates set meta_status = 'approved'");
    });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query(
      "update wallets set monthly_cap_paise = null, notified_state = null where clinic_id = $1",
      [clinicId],
    );
  });

  it("a clinic's own rate wins over the default; the latest in force is used", async () => {
    expect((await run((c) => rateFor(c, "telephony_min", NOW)))!.providerCostPaise).toBe(60);
    await db.pool.query(
      "insert into rate_cards (clinic_id, kind, unit, provider_cost_paise, margin_pct, effective_from) values ($1, 'telephony_min', 'minute', 50, 20, '2030-05-01'), ($1, 'telephony_min', 'minute', 40, 20, '2030-06-01')",
      [clinicId],
    );
    expect(await run((c) => rateFor(c, "telephony_min", NOW))).toEqual({
      providerCostPaise: 50,
      marginPct: 20,
      marginPaise: 0,
    });
    expect(
      (await run((c) => rateFor(c, "telephony_min", new Date("2030-06-02T00:00:00Z"))))!.providerCostPaise,
    ).toBe(40);
  });

  it("a call is metered once, in two halves: speech and model at hang-up, minutes from the provider", async () => {
    await setBalance(100000);
    const callId = await run(async (c) => {
      const id = (
        await c.query(
          "insert into calls (clinic_id, provider, provider_call_id, route, usage) values (app.current_clinic_id(), 'fake', 'm1', 'assistant', $1) returning id",
          [{ stt_ms: 95000, tts_chars: 1200, llm_input_tokens: 4000, llm_output_tokens: 300 }],
        )
      ).rows[0].id as string;
      await meterCall(c, id, NOW);
      await c.query("update calls set duration_sec = 125 where id = $1", [id]);
      await meterCall(c, id, NOW);
      await meterCall(c, id, NOW); // the provider retried its callback
      return id;
    });
    const rows = await run(
      async (c) =>
        (
          await c.query(
            "select kind, quantity::float8 as q, total_paise from usage_ledger where ref = $1 order by kind",
            [callId],
          )
        ).rows,
    );
    expect(rows.map((r) => [r.kind, r.q])).toEqual([
      ["llm_input_token", 4000],
      ["llm_output_token", 300],
      ["stt_sec", 95],
      ["telephony_min", 3],
      ["tts_char", 1200],
    ]);
    const total = rows.reduce((s, r) => s + Number(r.total_paise), 0);
    const call = await run(
      async (c) => (await c.query("select cost_estimate_paise from calls where id = $1", [callId])).rows[0],
    );
    expect(call.cost_estimate_paise).toBe(total);
    expect((await run((c) => walletStatus(c, NOW))).balancePaise).toBe(100000 - total);
  });

  it("templates are metered when sent; chat replies and Sentio's own notices are not", async () => {
    await setBalance(100000);
    const p = await run((c) => createPatient(c, { name: "Mohan Lal", phone: "+919000500001" }));
    const send = (purpose: string, category: "transactional" | "critical", key: string) =>
      run(async (c) => {
        const id = (await enqueueMessage(c, {
          to: p.phone!,
          category,
          purpose,
          patientId: p.id,
          dedupeKey: key,
          payload: {
            kind: "template",
            purpose: purpose as "payment_receipt",
            language: "en",
            params: ["a", "b", "c", "d", "e"],
          },
        }))!;
        return { id, outcome: await processOutbox(c, id, { messaging, channel, now: () => NOW }) };
      });
    const receipt = await send("payment_receipt", "transactional", "m-1");
    expect(receipt.outcome.status).toBe("sent");
    const notice = await send("billing_wallet_low", "critical", "m-2");
    expect(notice.outcome.status).toBe("sent");
    const metered = await run(
      async (c) => (await c.query("select ref, kind from usage_ledger where ref_type = 'outbox'")).rows,
    );
    expect(metered).toEqual([{ ref: receipt.id, kind: "wa_utility" }]);
  });

  it("suspended: reminders wait (and go once the wallet is paid up); safety messages still go", async () => {
    await setBalance(-50000); // below the ₹200 grace
    expect((await run((c) => walletStatus(c, NOW))).state).toBe("suspended");
    const p = await run((c) => createPatient(c, { name: "Rani Bai", phone: "+919000500002" }));
    const queue = (category: "transactional" | "critical", key: string) =>
      run(async (c) => {
        const id = (await enqueueMessage(c, {
          to: p.phone!,
          category,
          purpose: "reminder",
          patientId: p.id,
          dedupeKey: key,
          payload: { kind: "template", purpose: "staff_alert", language: "en", params: ["x", "y", "z"] },
        }))!;
        return { id, outcome: await processOutbox(c, id, { messaging, channel, now: () => NOW }) };
      });
    const reminder = await queue("transactional", "s-1");
    expect(reminder.outcome).toMatchObject({ status: "retry", reason: "wallet_paused" });
    const alert = await queue("critical", "s-2");
    expect(alert.outcome.status).toBe("sent");
    // Grace (just below zero): transactional messages go again.
    await setBalance(-1000);
    expect((await run((c) => walletStatus(c, NOW))).state).toBe("grace");
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const again = await run((c) => processOutbox(c, reminder.id, { messaging, channel, now: () => later }));
    expect(again.status).toBe("sent");
  });

  it("campaigns are refused while the wallet is not paid up", async () => {
    await setBalance(-1000);
    const owner = (
      await db.pool.query("insert into users (id, name) values (gen_random_uuid(), 'Dr. W') returning id")
    ).rows[0].id as string;
    const c1 = await run((c) =>
      createCampaign(c, { name: "C", inactiveMonths: 12, offerText: "We are open on Sundays." }),
    );
    await run((c) => submitCampaign(c, c1.id));
    await run((c) => approveCampaign(c, c1.id, owner));
    await expect(run((c) => runCampaign(c, c1.id, NOW))).rejects.toThrow(/paused/);
    await setBalance(100000);
    await expect(run((c) => runCampaign(c, c1.id, NOW))).resolves.toBeTruthy();
  });

  it("owner notices: once per change, with a top-up link; spend alerts once per level per month", async () => {
    await db.pool.query(
      "update clinic_memberships set invited_phone = '+919835000091' where clinic_id = $1 and role = 'owner'",
      [clinicId],
    );
    await setBalance(30000); // below the ₹500 low level
    const first = await run((c) => walletNotices(c, { payments }, NOW));
    expect(first).toHaveLength(1);
    expect(await run((c) => walletNotices(c, { payments }, NOW))).toHaveLength(0);
    const low = await run(
      async (c) => (await c.query("select payload from outbox where id = $1", [first[0]])).rows[0].payload,
    );
    expect(low.purpose).toBe("billing_wallet_low");
    expect(low.params[3]).toMatch(/^https:\/\/pay\.fake\.local\//);
    expect(payments.links.at(-1)).toMatchObject({
      referenceId: expect.stringMatching(/^recharge:/),
      account: null,
    });

    await setBalance(-60000);
    const paused = await run((c) => walletNotices(c, { payments }, NOW));
    expect(paused).toHaveLength(1);
    expect(
      (
        await run(
          async (c) => (await c.query("select payload from outbox where id = $1", [paused[0]])).rows[0],
        )
      ).payload.purpose,
    ).toBe("billing_wallet_paused");

    // Spending limit: this month's usage so far against a limit set just above half of it.
    await setBalance(100000);
    await run((c) => walletNotices(c, { payments }, NOW)); // back to active: nothing sent
    const spent = (await run((c) => walletStatus(c, NOW))).spentThisMonthPaise;
    await db.pool.query("update wallets set monthly_cap_paise = $2 where clinic_id = $1", [
      clinicId,
      Math.ceil(spent * 1.5),
    ]);
    const alerts = await run((c) => walletNotices(c, { payments }, NOW));
    expect(alerts).toHaveLength(1); // 50% only (spent is 2/3 of the limit)
    expect(await run((c) => walletNotices(c, { payments }, NOW))).toHaveLength(0);
  });

  it("the same usage reference is charged once", async () => {
    const a = await run((c) =>
      meter(c, { kind: "sms_segment", quantity: 2, refType: "sms", ref: "sms-1", at: NOW }),
    );
    const b = await run((c) =>
      meter(c, { kind: "sms_segment", quantity: 2, refType: "sms", ref: "sms-1", at: NOW }),
    );
    expect(a).toBe(60); // 2 × ₹0.20 + 50%
    expect(b).toBeNull();
  });
});

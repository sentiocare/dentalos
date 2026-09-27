import { FakeMessagingProvider, FakePaymentProvider } from "@dentalos/adapters";
import {
  approveCampaign,
  createCampaign,
  createLicense,
  DEFAULT_SELLER,
  debitDueRecharges,
  enqueueMessage,
  getWhatsAppChannel,
  ingestSentioPaymentEvent,
  planRecharges,
  processOutbox,
  reconcile,
  registerStandardTemplates,
  runCampaign,
  startMandateRegistration,
  submitCampaign,
  topupLink,
  walletNotices,
  walletStatus,
} from "@dentalos/core";
import { withClinic, withPlatform } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PatientSimulator } from "../testing/harness";
import { setupVoiceClinic, VOICE_NUMBER } from "../testing/voice-harness";
import { endCall } from "../voice/call";
import { recordCallStatus } from "../voice/flow";
import { routeInboundCall } from "../voice/routing";

/**
 * Phase 5 acceptance (PLAN §7): a test month of synthetic usage, run through the real code paths (calls,
 * WhatsApp templates, AI chats, the worker's billing jobs), with a mandate that fails in the third week.
 *
 * - Usage reconciles with provider bills within 1%. The bills are computed here from the raw events, the
 *   way each provider bills (Exotel per started minute, Sarvam per started second of audio per request,
 *   Meta per delivered template, the model per token), not from our ledger.
 * - The empty-wallet and failed-mandate path matches §4.3 for each capability.
 * - Emergencies still reach a doctor while the wallet is suspended.
 * - Every automatic debit was announced at least 24 hours before and was ≤ ₹15,000.
 */
const T0 = new Date("2030-08-01T00:00:00+05:30");
const HOUR = 3600_000;

/** Small deterministic PRNG so the month is the same every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe.skipIf(!hasTestDatabase)("Phase 5 acceptance: a billed month", () => {
  let db: TestDatabase;
  let clinic: { clinicId: string; key: Buffer };
  const messaging = new FakeMessagingProvider();
  const payments = new FakePaymentProvider();
  const deps = { payments, seller: DEFAULT_SELLER };
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: clinic.clinicId, actor: "system", role: "system" }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    clinic = await setupVoiceClinic(db.pool, "Billing Month Dental");
    await run(async (c) => {
      await registerStandardTemplates(c);
      await c.query("update message_templates set meta_status = 'approved'");
    });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("runs the month: bills reconcile within 1%, the wallet states behave as §4.3, debits are announced", async () => {
    const random = rng(20300801);
    const channel = (c: PoolClient) => getWhatsAppChannel(c, clinic.key);
    const send = (id: string, now: Date) =>
      run((c) => processOutbox(c, id, { messaging, channel, now: () => now }));

    // --- Onboarding: license paid, auto-recharge mandate authorised, ₹1,000 opening balance.
    const lic = await withPlatform(db.pool, "system", (c) =>
      createLicense(c, deps, { clinicId: clinic.clinicId, sku: "standard", pricePaise: 4_999_900, now: T0 }),
    );
    let eventNo = 0;
    const captured = (referenceId: string, amountPaise: number, at: Date) =>
      ingestSentioPaymentEvent(
        db.pool,
        {
          type: "payment_captured",
          eventId: `sim-${++eventNo}`,
          providerPaymentId: `pay-sim-${eventNo}`,
          amountPaise,
          referenceId,
          method: "upi",
          at,
        },
        deps,
      );
    expect((await captured(`license:${lic.licenseId}`, lic.totalPaise, T0)).outcome).toBe("license_paid");
    const reg = await withPlatform(db.pool, "system", (c) =>
      startMandateRegistration(c, deps, { clinicId: clinic.clinicId, method: "upi_autopay" }),
    );
    const customer = (
      await db.pool.query("select provider_customer_id from mandates where id = $1", [reg.mandateId])
    ).rows[0].provider_customer_id;
    const mandateId = payments.activateMandate(1_500_000, `${customer}:tok_sim`);
    await ingestSentioPaymentEvent(
      db.pool,
      {
        type: "mandate_status",
        eventId: "sim-mandate",
        providerMandateId: mandateId,
        providerCustomerId: customer,
        status: "active",
        method: "upi_autopay",
        at: T0,
      },
      deps,
    );
    // Small amounts, so a month is enough to run the wallet down: ₹500 recharges (₹424 of credit after
    // GST), low below ₹300, ₹100 of grace, ₹600 to start.
    await db.pool.query(
      "update wallets set recharge_amount_paise = 50000, threshold_paise = 30000, grace_paise = 10000 where clinic_id = $1",
      [clinic.clinicId],
    );
    await db.pool.query(
      "insert into wallet_credits (clinic_id, kind, amount_paise, note) values ($1, 'opening', 60000, 'Opening balance')",
      [clinic.clinicId],
    );
    // Debits are timed by the simulated clock.
    const debits: { at: Date; amountPaise: number; referenceId: string }[] = [];
    let clock = T0;
    const charge = payments.chargeMandate.bind(payments);
    payments.chargeMandate = async (input) => {
      const r = await charge(input);
      debits.push({ at: clock, amountPaise: input.amountPaise, referenceId: input.referenceId });
      return r;
    };

    // --- Raw events, for the providers' own bills.
    const calls: { durationSec: number; sttMs: number; tts: number; llmIn: number; llmOut: number }[] = [];
    const chatLlm = { input: 0, output: 0 };
    const routes: { state: string; route: string }[] = [];
    const held = new Set<string>();
    const reminderOutcomes: { state: string; status: string }[] = [];
    const states: string[] = [];
    let emergencyChecked = false;
    let suspendedSince: Date | null = null;
    let toppedUp = false;
    let campaignChecked = false;
    let n = 0;

    for (let h = 0; h < 30 * 24; h++) {
      const now = new Date(T0.getTime() + h * HOUR);
      clock = now;
      const hourOfDay = h % 24;
      const day = Math.floor(h / 24) + 1;
      const w = await run((c) => walletStatus(c, now));
      if (states.at(-1) !== w.state) states.push(w.state);

      // Day 12: the owner revokes the mandate in their UPI app; debits start failing.
      if (h === 11 * 24) await payments.cancelMandate(mandateId);
      if (w.state === "suspended" && !suspendedSince) suspendedSince = now;

      if (hourOfDay >= 9 && hourOfDay < 21) {
        // Patients call.
        const callsNow = Math.floor(random() * 4);
        for (let i = 0; i < callsNow; i++) {
          const providerCallId = `sim-call-${++n}`;
          const stateNow = (await run((c) => walletStatus(c, now))).state;
          const routed = await routeInboundCall(
            db.pool,
            {
              provider: "fake",
              providerCallId,
              from: `+9190080${String(10000 + (n % 400))}`,
              to: VOICE_NUMBER,
            },
            { voiceHealthy: true, now },
          );
          routes.push({ state: stateNow, route: routed!.route });
          const durationSec = 30 + Math.floor(random() * 360);
          const usage =
            routed!.route === "assistant"
              ? {
                  sttMs: 20_000 + Math.floor(random() * 100_000),
                  ttsChars: 300 + Math.floor(random() * 1200),
                  llmInputTokens: 1000 + Math.floor(random() * 4000),
                  llmOutputTokens: 100 + Math.floor(random() * 300),
                }
              : { sttMs: 0, ttsChars: 0, llmInputTokens: 0, llmOutputTokens: 0 };
          if (routed!.route === "assistant")
            await endCall(
              db.pool,
              { clinicId: clinic.clinicId, callId: routed!.callId, phone: null },
              usage,
              now,
            );
          await recordCallStatus(db.pool, "fake", {
            providerCallId,
            status: "completed",
            durationSec,
            recordingUrl: null,
            at: new Date(now.getTime() + durationSec * 1000),
          });
          calls.push({
            durationSec,
            sttMs: usage.sttMs,
            tts: usage.ttsChars,
            llmIn: usage.llmInputTokens,
            llmOut: usage.llmOutputTokens,
          });
        }

        // Appointment reminders (utility templates).
        if (random() < 0.6) {
          const stateNow = (await run((c) => walletStatus(c, now))).state;
          const id = await run(
            async (c) =>
              (await enqueueMessage(c, {
                to: `+9190081${String(10000 + (n % 300))}`,
                category: "transactional",
                purpose: "reminder_day_before",
                dedupeKey: `sim-reminder-${h}`,
                notBefore: now,
                payload: {
                  kind: "template",
                  purpose: "reminder_day_before",
                  language: "en",
                  params: ["A", "B", "C", "D", "E", "F"],
                },
              }))!,
          );
          const out = await send(id, now);
          reminderOutcomes.push({ state: stateNow, status: out.status });
          if (out.status === "retry") held.add(id);
        }
        // Reminders held earlier go when allowed again.
        for (const id of [...held]) {
          const out = await send(id, now);
          if (out.status === "sent") held.delete(id);
        }

        // Twice a day a patient chats with the assistant and asks something the rules can't answer.
        if (hourOfDay === 11 || hourOfDay === 17) {
          const p = new PatientSimulator(
            db.pool,
            clinic,
            `+9190082${String(10000 + day * 2 + (hourOfDay === 17 ? 1 : 0))}`,
            now,
          );
          p.messaging.sent.length = 0;
          await p.say("Namaste");
          await p.tap("agree", "Agree");
          await p.say("mujhe apne daant ke baare mein kuch poochna tha, woh jo pichhli baar hua tha");
          for (const r of p.llm.extractRequests) {
            chatLlm.input += Math.ceil((r.system.length + r.input.length) / 4);
            chatLlm.output += 20;
          }
          // Its sends went through its own fake provider: count its templates for Meta's bill too.
          messaging.sent.push(...p.messaging.sent.filter((m) => m.kind === "template"));
        }
      }

      // §4.3 while suspended: calls ring the clinic, campaigns refuse, an emergency still reaches a doctor.
      if (w.state === "suspended" && !emergencyChecked) {
        emergencyChecked = true;
        const p = new PatientSimulator(db.pool, clinic, "+919008399999", now);
        await p.say("bahut khoon aa raha hai daant nikalne ke baad, ruk nahi raha");
        const alert = (
          await db.pool.query(
            "select status from outbox where purpose = 'staff_emergency_alert' and clinic_id = $1 order by created_at desc limit 1",
            [clinic.clinicId],
          )
        ).rows[0];
        expect(alert.status).toBe("sent");
        messaging.sent.push(...p.messaging.sent.filter((m) => m.kind === "template"));
      }
      if (w.state === "suspended" && !campaignChecked) {
        campaignChecked = true;
        const owner = (
          await db.pool.query("insert into users (id, name) values (gen_random_uuid(), 'Owner') returning id")
        ).rows[0].id;
        await expect(
          run(async (c) => {
            const k = await createCampaign(c, {
              name: "Sundays",
              inactiveMonths: 12,
              offerText: "We are open on Sundays.",
            });
            await submitCampaign(c, k.id);
            await approveCampaign(c, k.id, owner);
            return runCampaign(c, k.id, now);
          }),
        ).rejects.toThrow(/paused/);
      }

      // Two days after everything paused, the owner adds ₹5,900 (₹5,000 of credit) by payment link.
      if (suspendedSince && !toppedUp && now.getTime() - suspendedSince.getTime() >= 48 * HOUR) {
        toppedUp = true;
        const link = await run((c) =>
          topupLink(c, { payments }, { amountPaise: 590_000, ownerPhone: "+919835000001", now }),
        );
        expect((await captured(`recharge:${link.rechargeId}`, 590_000, now)).outcome).toBe("recharge_paid");
      }

      // The worker's billing jobs (hourly forecast; debits; the gateway confirms successful debits).
      const planned = await planRecharges(db.pool, now);
      for (const p of planned) if (p.outboxId) await send(p.outboxId, now);
      const before = debits.length;
      await debitDueRecharges(db.pool, deps, now);
      for (const d of debits.slice(before))
        await captured(d.referenceId, d.amountPaise, new Date(now.getTime() + 60_000));
      for (const id of await run((c) => walletNotices(c, { payments }, now))) await send(id, now);
      const failed = (
        await db.pool.query(
          "select id from outbox where clinic_id = $1 and purpose = 'billing_recharge_failed' and status = 'pending'",
          [clinic.clinicId],
        )
      ).rows;
      for (const f of failed) await send(f.id, now);
    }

    // --- The wallet went through every state and came back.
    const order = ["active", "low", "grace", "suspended", "active"];
    let k = 0;
    for (const s of states) if (s === order[k]) k++;
    expect(k, `states seen: ${states.join(" → ")}`).toBe(order.length);

    // --- §4.3 per capability, from what actually happened.
    for (const r of routes)
      expect(r.route, `a call while ${r.state}`).toBe(
        r.state === "active" || r.state === "low" ? "assistant" : "forwarded_wallet",
      );
    for (const r of reminderOutcomes)
      expect(r.status, `a reminder while ${r.state}`).toBe(r.state === "suspended" ? "retry" : "sent");
    expect(reminderOutcomes.some((r) => r.state === "suspended")).toBe(true);
    expect(held.size).toBe(0); // every held reminder went out after the top-up
    expect(emergencyChecked && campaignChecked && toppedUp).toBe(true);

    // --- Every automatic debit was announced 24 hours ahead and within the limit.
    const recharges = (
      await db.pool.query(
        "select id, amount_paise, pre_debit_notified_at from recharges where clinic_id = $1 and via = 'mandate'",
        [clinic.clinicId],
      )
    ).rows;
    expect(debits.length).toBeGreaterThan(0);
    for (const d of debits) {
      const r = recharges.find((x) => `recharge:${x.id}` === d.referenceId)!;
      expect(d.at.getTime() - r.pre_debit_notified_at.getTime()).toBeGreaterThanOrEqual(24 * HOUR);
      expect(d.amountPaise).toBeLessThanOrEqual(1_500_000);
    }
    const notices = (
      await db.pool.query(
        "select count(*)::int as n from outbox where clinic_id = $1 and purpose = 'billing_predebit'",
        [clinic.clinicId],
      )
    ).rows[0].n;
    expect(notices).toBeGreaterThanOrEqual(debits.length);

    // --- Reconciliation with the providers' bills, computed from the raw events.
    const bills = {
      telephony: calls.reduce((s, c) => s + Math.ceil(c.durationSec / 60) * 60, 0),
      speech: calls.reduce((s, c) => s + Math.ceil(c.sttMs / 1000) * 0.5 + c.tts * 0.015, 0),
      llm:
        calls.reduce((s, c) => s + c.llmIn * 0.025 + c.llmOut * 0.125, 0) +
        chatLlm.input * 0.025 +
        chatLlm.output * 0.125,
      whatsapp: messaging.sent.filter((m) => m.kind === "template").length * 13,
    };
    const result = await reconcile(db.pool, { periodStart: "2030-07-31", periodEnd: "2030-09-01", bills });
    for (const p of ["telephony", "speech", "llm", "whatsapp", "wallet_balances"])
      expect(
        result.find((r) => r.provider === p),
        `${p}: ${JSON.stringify(result.find((r) => r.provider === p))}`,
      ).toMatchObject({
        status: "ok",
      });
    expect(calls.length).toBeGreaterThan(300);
  }, 600_000);
});

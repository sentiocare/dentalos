import { FakePaymentProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { meter } from "./metering";
import {
  createLicense,
  DEFAULT_SELLER,
  debitDueRecharges,
  ingestSentioPaymentEvent,
  planRecharges,
  reconcile,
  renderSentioInvoicePdf,
  startMandateRegistration,
} from "./sentio";
import { topupLink, walletStatus } from "./wallet";

const seller = {
  ...DEFAULT_SELLER,
  legalName: "Sentio Care Pvt Ltd",
  gstin: "20ABCDE1234F1Z5",
  state: "Jharkhand",
};
const T0 = new Date("2030-07-01T10:00:00+05:30");
const hours = (h: number) => new Date(T0.getTime() + h * 3600_000);

describe.skipIf(!hasTestDatabase)(
  "Sentio billing: license, mandate, recharges, invoices, reconciliation",
  () => {
    let db: TestDatabase;
    let clinicId: string;
    let otherState: string;
    const payments = new FakePaymentProvider();
    const deps = { payments, seller };
    const run = <T>(fn: (c: PoolClient) => Promise<T>, id = clinicId) =>
      withClinic(db.pool, { clinicId: id, actor: "system", role: "system" }, fn);
    const platform = async <T>(fn: (c: PoolClient) => Promise<T>) => {
      const c = await db.pool.connect();
      try {
        await c.query("begin");
        const r = await fn(c);
        await c.query("commit");
        return r;
      } finally {
        c.release();
      }
    };
    let eventNo = 0;
    const captured = (referenceId: string, amountPaise: number, at = T0) =>
      ingestSentioPaymentEvent(
        db.pool,
        {
          type: "payment_captured",
          eventId: `e${++eventNo}`,
          providerPaymentId: `pay_${eventNo}`,
          amountPaise,
          referenceId,
          method: "upi",
          at,
        },
        deps,
      );
    const wallet = () => run((c) => walletStatus(c, T0));

    beforeAll(async () => {
      db = await createTestDatabase();
      const client = await db.pool.connect();
      try {
        ({ clinicId } = await createClinic(client, {
          name: "Sentio Billing Dental",
          owner: { name: "Dr. S", phone: "9835000101" },
        }));
        await client.query(
          "update clinics set state = 'Jharkhand', gstin = '20PQRSX1234A1Z1' where id = $1",
          [clinicId],
        );
        ({ clinicId: otherState } = await createClinic(client, {
          name: "Patna Dental",
          owner: { name: "Dr. P", phone: "9835000102" },
        }));
        await client.query("update clinics set state = 'Bihar' where id = $1", [otherState]);
        await client.query(
          "update clinic_memberships set invited_phone = case when display_name = 'Dr. S' then '+919835000101' else '+919835000102' end where role = 'owner'",
        );
      } finally {
        client.release();
      }
    });
    afterAll(async () => {
      await db?.drop();
    });

    it("license: paid by link, invoiced with CGST+SGST in the same state, billing switched on; retries change nothing", async () => {
      expect((await wallet()).enforced).toBe(false);
      const lic = await platform((c) =>
        createLicense(c, deps, { clinicId, sku: "standard", pricePaise: 4_999_900, now: T0 }),
      );
      expect(lic.totalPaise).toBe(4_999_900 + 899_982);
      expect(payments.links.at(-1)).toMatchObject({ referenceId: `license:${lic.licenseId}`, account: null });
      const paid = await captured(`license:${lic.licenseId}`, lic.totalPaise);
      expect(paid.outcome).toBe("license_paid");
      const again = await ingestSentioPaymentEvent(
        db.pool,
        {
          type: "payment_captured",
          eventId: `e${eventNo}`,
          providerPaymentId: `pay_${eventNo}`,
          amountPaise: lic.totalPaise,
          referenceId: `license:${lic.licenseId}`,
          method: "upi",
          at: T0,
        },
        deps,
      );
      expect(again.outcome).toBe("duplicate");
      const l = (
        await db.pool.query("select status, updates_support_until::text from licenses where id = $1", [
          lic.licenseId,
        ])
      ).rows[0];
      expect(l).toEqual({ status: "paid", updates_support_until: "2031-07-01" });
      const inv = (await db.pool.query("select * from sentio_invoices where clinic_id = $1", [clinicId]))
        .rows;
      expect(inv).toHaveLength(1);
      expect(inv[0]).toMatchObject({
        kind: "license",
        number: "SNT/2030-31/000001",
        cgst_paise: 449991,
        sgst_paise: 449991,
        igst_paise: 0,
        total_paise: 5_899_882,
      });
      expect((await wallet()).enforced).toBe(true);
      const pdf = await PDFDocument.load(await platform((c) => renderSentioInvoicePdf(c, seller, inv[0].id)));
      expect(pdf.getTitle()).toBe("Tax invoice SNT/2030-31/000001");
    });

    it("another state pays IGST", async () => {
      const lic = await platform((c) =>
        createLicense(c, deps, { clinicId: otherState, sku: "standard", pricePaise: 100_000, now: T0 }),
      );
      await captured(`license:${lic.licenseId}`, lic.totalPaise);
      const inv = (
        await db.pool.query(
          "select cgst_paise, sgst_paise, igst_paise from sentio_invoices where clinic_id = $1",
          [otherState],
        )
      ).rows[0];
      expect(inv).toEqual({ cgst_paise: 0, sgst_paise: 0, igst_paise: 18000 });
    });

    it("mandate: registration page, then the gateway confirms it", async () => {
      const reg = await platform((c) =>
        startMandateRegistration(c, deps, { clinicId, method: "upi_autopay" }),
      );
      expect(reg.url).toMatch(/mandate/);
      const m = (
        await db.pool.query("select provider_customer_id, max_amount_paise from mandates where id = $1", [
          reg.mandateId,
        ])
      ).rows[0];
      expect(m.max_amount_paise).toBe(1_500_000);
      const providerMandateId = payments.activateMandate(1_500_000, `${m.provider_customer_id}:token_1`);
      const res = await ingestSentioPaymentEvent(
        db.pool,
        {
          type: "mandate_status",
          eventId: "tok-1",
          providerMandateId,
          providerCustomerId: m.provider_customer_id,
          status: "active",
          method: "upi_autopay",
          at: T0,
        },
        deps,
      );
      expect(res).toEqual({ outcome: "mandate", clinicId, status: "active" });
    });

    it("auto-recharge: notice first, debit no sooner than 24 hours later, credited without GST when paid", async () => {
      // ₹400 a day of usage over the last week; ₹800 left; low level ₹500 → recharge needed within 48 hours.
      await run(async (c) => {
        for (let d = 1; d <= 7; d++)
          await meter(c, {
            kind: "telephony_min",
            quantity: 444,
            refType: "call",
            ref: `burn-${d}`,
            at: hours(-24 * d + 1),
          });
      });
      const now = (await wallet()).balancePaise;
      await db.pool.query(
        "insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'adjustment', $2)",
        [clinicId, 80000 - now],
      );
      const planned = await planRecharges(db.pool, T0);
      expect(planned).toEqual([expect.objectContaining({ clinicId, amountPaise: 200000 })]);
      expect(planned[0]!.outboxId).toBeTruthy();
      const notice = (await db.pool.query("select payload from outbox where id = $1", [planned[0]!.outboxId]))
        .rows[0].payload;
      expect(notice.purpose).toBe("billing_predebit");
      expect(notice.params[2]).toBe("₹2,000");
      expect(await planRecharges(db.pool, hours(1))).toEqual([]); // one open recharge at a time

      expect(await debitDueRecharges(db.pool, deps, hours(23))).toEqual({
        debited: 0,
        cancelled: 0,
        failed: 0,
      });
      expect(await debitDueRecharges(db.pool, deps, hours(24))).toEqual({
        debited: 1,
        cancelled: 0,
        failed: 0,
      });
      expect(payments.charges.at(-1)).toMatchObject({
        amountPaise: 200000,
        referenceId: `recharge:${planned[0]!.rechargeId}`,
      });
      const before = (await wallet()).balancePaise;
      const paid = await captured(`recharge:${planned[0]!.rechargeId}`, 200000, hours(24.1));
      expect(paid).toMatchObject({ outcome: "recharge_paid", creditedPaise: 169492 });
      expect((await wallet()).balancePaise).toBe(before + 169492);
      // Paying twice (a retried webhook with a new id) never credits twice.
      expect((await captured(`recharge:${planned[0]!.rechargeId}`, 200000, hours(24.2))).outcome).toBe(
        "duplicate",
      );
    });

    it("a refused debit: the owner gets a pay-by-link message; three in a row and the mandate is marked failed", async () => {
      const m = (
        await db.pool.query(
          "select provider_mandate_id from mandates where clinic_id = $1 and status = 'active'",
          [clinicId],
        )
      ).rows[0];
      await payments.cancelMandate(m.provider_mandate_id); // e.g. the owner revoked it in their UPI app
      for (let i = 0; i < 3; i++) {
        const bal = (await wallet()).balancePaise;
        await db.pool.query(
          "insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'adjustment', $2)",
          [clinicId, 10000 - bal],
        );
        const at = hours(48 + i * 48);
        const planned = await planRecharges(db.pool, at);
        expect(planned).toHaveLength(1);
        expect(await debitDueRecharges(db.pool, deps, new Date(at.getTime() + 24 * 3600_000))).toMatchObject({
          failed: 1,
        });
      }
      const mandate = (
        await db.pool.query(
          "select status, consecutive_failures from mandates where clinic_id = $1 and provider_mandate_id is not null",
          [clinicId],
        )
      ).rows[0];
      expect(mandate).toEqual({ status: "failed", consecutive_failures: 3 });
      const msgs = (
        await db.pool.query(
          "select payload from outbox where purpose = 'billing_recharge_failed' and clinic_id = $1",
          [clinicId],
        )
      ).rows;
      expect(msgs).toHaveLength(3);
      expect(msgs[0].payload.params[3]).toMatch(/^https:\/\/pay\.fake\.local\//);
      // No more auto-recharges on a failed mandate.
      expect(await planRecharges(db.pool, hours(400))).toEqual([]);
    });

    it("manual top-up by link is credited once, with an invoice", async () => {
      const link = await run((c) =>
        topupLink(c, { payments }, { amountPaise: 118000, ownerPhone: "+919835000101", now: T0 }),
      );
      const before = (await wallet()).balancePaise;
      expect((await captured(`recharge:${link.rechargeId}`, 118000)).outcome).toBe("recharge_paid");
      expect((await wallet()).balancePaise).toBe(before + 100000);
    });

    it("reconciliation: within 1% is fine, more is flagged; every wallet balance matches its ledger", async () => {
      const ours = Number(
        (
          await db.pool.query(
            "select sum(provider_cost_paise) as s from usage_ledger where kind = 'telephony_min' and at >= '2030-06-01' and at < '2030-07-02'",
          )
        ).rows[0].s,
      );
      const ok = await reconcile(db.pool, {
        periodStart: "2030-06-01",
        periodEnd: "2030-07-01",
        bills: { telephony: Math.round(ours * 1.004), speech: null },
      });
      expect(ok.find((r) => r.provider === "telephony")?.status).toBe("ok");
      expect(ok.find((r) => r.provider === "speech")?.status).toBe("unavailable");
      expect(ok.find((r) => r.provider === "wallet_balances")?.status).toBe("ok");
      const bad = await reconcile(db.pool, {
        periodStart: "2030-06-01",
        periodEnd: "2030-07-01",
        bills: { telephony: Math.round(ours * 1.05) },
      });
      expect(bad.find((r) => r.provider === "telephony")?.status).toBe("drift");
    });
  },
);

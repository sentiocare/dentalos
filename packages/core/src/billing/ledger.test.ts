import { FakePaymentProvider, FakeStorageProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import { advanceFollowups, planFollowups } from "../revenue/followups";
import {
  addAdjustment,
  addCharge,
  collections,
  connectPaymentAccount,
  createInvoice,
  createPatientPaymentLink,
  duesList,
  financialYear,
  getPaymentAccount,
  gstIncluded,
  ledgerExport,
  patientAccount,
  paymentLinkPaid,
  recordPayment,
  refundPayment,
  renderInvoicePdf,
  renderReceiptPdf,
  reverseEntry,
  sendReceipt,
} from "./ledger";

const NOW = new Date("2030-03-30T11:00:00+05:30");

describe("money helpers", () => {
  it("financial year runs April to March in the clinic's time zone", () => {
    expect(financialYear(new Date("2030-03-31T19:00:00Z"), "Asia/Kolkata")).toBe("2030-31"); // 00:30 on 1 April IST
    expect(financialYear(new Date("2030-03-31T18:00:00Z"), "UTC")).toBe("2029-30");
    expect(financialYear(new Date("2030-01-15T10:00:00Z"), "Asia/Kolkata")).toBe("2029-30");
    expect(financialYear(new Date("2099-12-01T10:00:00Z"), "Asia/Kolkata")).toBe("2099-00");
  });

  it("GST included in a price", () => {
    expect(gstIncluded(118_00, 1800)).toBe(18_00);
    expect(gstIncluded(500_00, 0)).toBe(0);
    expect(gstIncluded(999, 1800)).toBe(152);
  });
});

describe.skipIf(!hasTestDatabase)("patient ledger", () => {
  let db: TestDatabase;
  let clinicId: string;
  let otherClinic: string;
  const run = <T>(fn: (c: PoolClient) => Promise<T>, id = clinicId) =>
    withClinic(db.pool, { clinicId: id, actor: "system", role: "owner" }, fn);
  const storage = new FakeStorageProvider();
  const payments = new FakePaymentProvider();
  const key = Buffer.alloc(32, 7);

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Ledger Dental",
        owner: { name: "Dr. L", phone: "9835000071" },
      }));
      ({ clinicId: otherClinic } = await createClinic(client, {
        name: "Other Dental",
        owner: { name: "Dr. O", phone: "9835000072" },
      }));
      await client.query(
        "update procedure_types set gst_mode = 'taxable', gst_rate_bps = 1800, sac_code = '999722' where clinic_id = $1 and code = 'whitening'",
        [clinicId],
      );
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  const procedure = (code: string) =>
    run(
      async (c) =>
        (await c.query("select id from procedure_types where code = $1", [code])).rows[0].id as string,
    );

  it("charges, payments, receipts and the balance; the same payment twice is booked once", async () => {
    const p = await run((c) => createPatient(c, { name: "Rekha Sinha", phone: "+919000400001" }));
    await run((c) =>
      addCharge(c, {
        patientId: p.id,
        amountPaise: 400000,
        description: "RCT sitting 1",
        procedureTypeId: null,
      }),
    );
    const pay = await run((c) =>
      recordPayment(c, {
        patientId: p.id,
        amountPaise: 150000,
        method: "upi",
        reference: "UPI123",
        dedupeKey: "offline-1",
        now: NOW,
      }),
    );
    expect(pay.receiptNumber).toBe("R/2029-30/0001");
    const again = await run((c) =>
      recordPayment(c, {
        patientId: p.id,
        amountPaise: 150000,
        method: "upi",
        dedupeKey: "offline-1",
        now: NOW,
      }),
    );
    expect(again).toMatchObject({ id: pay.id, receiptNumber: pay.receiptNumber, duplicate: true });
    const next = await run((c) =>
      recordPayment(c, { patientId: p.id, amountPaise: 50000, method: "cash", now: NOW }),
    );
    expect(next.receiptNumber).toBe("R/2029-30/0002");
    // After 31 March a new series starts.
    const april = await run((c) =>
      recordPayment(c, {
        patientId: p.id,
        amountPaise: 10000,
        method: "cash",
        now: new Date("2030-04-01T09:00:00+05:30"),
      }),
    );
    expect(april.receiptNumber).toBe("R/2030-31/0001");
    const acc = await run((c) => patientAccount(c, p.id));
    expect(acc.balancePaise).toBe(400000 - 150000 - 50000 - 10000);
    expect(acc.entries.map((e) => e.kind)).toEqual(["charge", "payment", "payment", "payment"]);
    expect(acc.entries.find((e) => e.id === pay.id)?.receipt?.number).toBe("R/2029-30/0001");
  });

  it("discounts, refunds and corrections keep the history and fix the balance", async () => {
    const p = await run((c) => createPatient(c, { name: "Amit Kumar", phone: "+919000400002" }));
    const charge = await run((c) =>
      addCharge(c, { patientId: p.id, amountPaise: 100000, description: "Scaling" }),
    );
    await run((c) =>
      addAdjustment(c, { patientId: p.id, amountPaise: -20000, description: "Family discount" }),
    );
    const pay = await run((c) =>
      recordPayment(c, { patientId: p.id, amountPaise: 100000, method: "cash", now: NOW }),
    );
    expect((await run((c) => patientAccount(c, p.id))).balancePaise).toBe(-20000); // paid too much
    await run((c) =>
      refundPayment(c, { paymentId: pay.id, amountPaise: 20000, method: "cash", reason: "Excess" }),
    );
    await expect(
      run((c) => refundPayment(c, { paymentId: pay.id, amountPaise: 90000, method: "cash", reason: "x" })),
    ).rejects.toThrow(/more than what was paid/);
    expect((await run((c) => patientAccount(c, p.id))).balancePaise).toBe(0);

    // A payment entered by mistake: reversed, receipt cancelled, number kept.
    const wrong = await run((c) =>
      recordPayment(c, { patientId: p.id, amountPaise: 5000, method: "upi", now: NOW }),
    );
    await run((c) => reverseEntry(c, { entryId: wrong.id, reason: "Entered twice" }));
    await expect(run((c) => reverseEntry(c, { entryId: wrong.id, reason: "again" }))).rejects.toThrow(
      /Already/,
    );
    const acc = await run((c) => patientAccount(c, p.id));
    expect(acc.balancePaise).toBe(0);
    expect(acc.entries.find((e) => e.id === wrong.id)).toMatchObject({
      reversed: true,
      receipt: { cancelled: true },
    });
    // An invoiced charge cannot be reversed.
    await run((c) => createInvoice(c, { patientId: p.id, now: NOW }));
    await expect(run((c) => reverseEntry(c, { entryId: charge.id, reason: "x" }))).rejects.toThrow(/invoice/);
  });

  it("invoices: GST per procedure, bill of supply when nothing is taxable, charges invoiced once", async () => {
    const p = await run((c) => createPatient(c, { name: "Neha Gupta", phone: "+919000400003" }));
    await run((c) =>
      addCharge(c, {
        patientId: p.id,
        amountPaise: 118000,
        description: "Teeth whitening",
        procedureTypeId: undefined,
      }),
    );
    const whitening = await procedure("whitening");
    await run((c) =>
      addCharge(c, {
        patientId: p.id,
        amountPaise: 590000,
        description: "Whitening",
        procedureTypeId: whitening,
      }),
    );
    const inv = await run((c) => createInvoice(c, { patientId: p.id, now: NOW }));
    expect(inv.totalPaise).toBe(708000);
    const row = await run(
      async (c) => (await c.query("select * from invoices where id = $1", [inv.id])).rows[0],
    );
    expect(row).toMatchObject({
      doc_type: "tax_invoice",
      gst_paise: 90000,
      taxable_paise: 618000,
      number: "INV/2029-30/0002", // the second in this clinic this year
    });
    expect(row.lines[1]).toMatchObject({ sac: "999722", gstRateBps: 1800, gstPaise: 90000 });
    await expect(run((c) => createInvoice(c, { patientId: p.id, now: NOW }))).rejects.toThrow(
      /nothing to invoice/,
    );

    const q = await run((c) => createPatient(c, { name: "Om Prakash", phone: "+919000400004" }));
    await run((c) => addCharge(c, { patientId: q.id, amountPaise: 50000, description: "Consultation" }));
    const bos = await run((c) => createInvoice(c, { patientId: q.id, now: NOW }));
    expect(
      await run(
        async (c) =>
          (await c.query("select doc_type from invoices where id = $1", [bos.id])).rows[0].doc_type,
      ),
    ).toBe("bill_of_supply");
    const pdf = await PDFDocument.load(await run((c) => renderInvoicePdf(c, inv.id)));
    expect(pdf.getTitle()).toBe("Invoice INV/2029-30/0002");
  });

  it("receipt PDF and WhatsApp: stored privately, sent as a link", async () => {
    const p = await run((c) => createPatient(c, { name: "राहुल वर्मा", phone: "+919000400005" }));
    const pay = await run((c) =>
      recordPayment(c, { patientId: p.id, amountPaise: 30000, method: "card", now: NOW }),
    );
    const pdf = await PDFDocument.load(await run((c) => renderReceiptPdf(c, pay.receiptId)));
    expect(pdf.getTitle()).toContain("Receipt R/");
    expect((await run((c) => sendReceipt(c, pay.receiptId, { storage }))).outboxId).toBeTruthy();
    expect(await run((c) => sendReceipt(c, pay.receiptId, { storage }))).toEqual({ outboxId: null });
    const out = await run(
      async (c) => (await c.query("select payload from outbox where purpose = 'payment_receipt'")).rows,
    );
    expect(out).toHaveLength(1);
    expect(out[0].payload.params[1]).toBe("₹300");
  });

  it("payment links: on the clinic's own account; paying marks the link, the advance and the ledger once", async () => {
    await run((c) =>
      connectPaymentAccount(c, key, {
        keyId: "rzp_test_abcdef12",
        keySecret: "secret123",
        webhookSecret: "whsecret1",
      }),
    );
    const account = await run((c) => getPaymentAccount(c, key));
    expect(account?.keyId).toBe("rzp_test_abcdef12");
    // Another clinic cannot see it.
    expect(await run((c) => getPaymentAccount(c, key), otherClinic)).toBeNull();

    const p = await run((c) => createPatient(c, { name: "Deepa Rao", phone: "+919000400006" }));
    await run((c) => addCharge(c, { patientId: p.id, amountPaise: 250000, description: "Crown" }));
    const link = await run((c) =>
      createPatientPaymentLink(
        c,
        { payments, account },
        { patientId: p.id, amountPaise: 250000, purpose: "dues" },
      ),
    );
    expect(payments.links.at(-1)).toMatchObject({
      referenceId: `plink:${link.id}`,
      account: "rzp_test_abcdef12",
    });
    const clinicOf = await run(
      async (c) => (await c.query("select app.clinic_for_payment_link($1) as id", [link.id])).rows[0].id,
    );
    expect(clinicOf).toBe(clinicId);

    const paid = await run((c) =>
      paymentLinkPaid(c, { linkId: link.id, providerPaymentId: "pay_1", amountPaise: 250000, at: NOW }),
    );
    const retried = await run((c) =>
      paymentLinkPaid(c, { linkId: link.id, providerPaymentId: "pay_1", amountPaise: 250000, at: NOW }),
    );
    expect(retried).toMatchObject({ duplicate: true, receiptNumber: paid!.receiptNumber });
    expect((await run((c) => patientAccount(c, p.id))).balancePaise).toBe(0);
    expect(
      await run(
        async (c) =>
          (await c.query("select status from payment_links where id = $1", [link.id])).rows[0].status,
      ),
    ).toBe("paid");
  });

  it("collections by day and method, dues list, and the export exclude reversed entries", async () => {
    const from = new Date("2030-03-01T00:00:00+05:30");
    const to = new Date("2030-04-01T00:00:00+05:30");
    const c1 = await run((c) => collections(c, { from, to }));
    const received = await run(async (c) =>
      Number(
        (
          await c.query(
            `select sum(amount_paise) as s from patient_ledger l where kind = 'payment' and created_at >= $1 and created_at < $2
             and not exists (select 1 from patient_ledger x where x.reverses_id = l.id)`,
            [from, to],
          )
        ).rows[0].s,
      ),
    );
    expect(c1.totals.receivedPaise).toBe(received);
    expect(c1.totals.byMethod.upi).toBe(150000); // the reversed ₹50 UPI payment is not counted
    expect(c1.dues.patients).toBeGreaterThan(0);
    const dues = await run((c) => duesList(c));
    expect(dues[0]!.balancePaise).toBeGreaterThanOrEqual(dues.at(-1)!.balancePaise);
    const rows = await run((c) =>
      ledgerExport(c, { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2100-01-01T00:00:00Z") }),
    );
    expect(rows.some((r) => r.correction)).toBe(true);
  });

  it("dues reminders: start after the grace days, wait for the link, stop when paid", async () => {
    const p = await run((c) => createPatient(c, { name: "Kiran Das", phone: "+919000400007" }));
    await run(async (c) => {
      await addCharge(c, { patientId: p.id, amountPaise: 300000, description: "Extraction" });
      // Pretend the charge was made five days ago.
      await c.query("select 1");
    });
    await db.pool.query("alter table patient_ledger disable trigger patient_ledger_append_only");
    await db.pool.query("update patient_ledger set created_at = $2 where patient_id = $1", [
      p.id,
      new Date(NOW.getTime() - 5 * 86_400_000),
    ]);
    await db.pool.query("alter table patient_ledger enable trigger patient_ledger_append_only");

    const planned = await run((c) => planFollowups(c, NOW));
    expect(planned.dues).toBeGreaterThanOrEqual(1);
    const at = new Date("2030-03-31T10:00:00+05:30");
    const first = await run((c) => advanceFollowups(c, at));
    const req = first.links.find((l) => l.patientId === p.id);
    expect(req).toMatchObject({ amountPaise: 300000 });
    // The worker makes the link; the next pass sends the reminder with it.
    const link = await run((c) =>
      createPatientPaymentLink(
        c,
        { payments, account: null },
        { patientId: p.id, amountPaise: 300000, purpose: "dues" },
      ),
    );
    const second = await run((c) => advanceFollowups(c, at));
    expect(second.messages).toBeGreaterThanOrEqual(1);
    const msg = await run(
      async (c) =>
        (
          await c.query("select payload from outbox where purpose = 'followup_dues' and patient_id = $1", [
            p.id,
          ])
        ).rows[0],
    );
    expect(msg.payload.params).toEqual(["Kiran Das", "Ledger Dental", "₹3,000", link.url]);
    await run((c) =>
      paymentLinkPaid(c, { linkId: link.id, providerPaymentId: "pay_dues", amountPaise: 300000, at }),
    );
    const run1 = await run(
      async (c) =>
        (await c.query("select status from followup_runs where kind = 'dues' and patient_id = $1", [p.id]))
          .rows[0],
    );
    expect(run1.status).toBe("stopped_success");
  });
});

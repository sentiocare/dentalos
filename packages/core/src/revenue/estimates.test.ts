import { FakeStorageProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClinic } from "../clinics/create";
import { createPatient } from "../patients/service";
import {
  createEstimate,
  decideEstimate,
  estimateFromPlan,
  expireEstimates,
  patientEstimates,
  renderEstimatePdf,
  sendEstimate,
} from "./estimates";
import { createTreatmentPlan, patientPlans } from "./treatments";

const NOW = new Date("2030-01-07T10:00:00+05:30");

describe.skipIf(!hasTestDatabase)("estimates", () => {
  let db: TestDatabase;
  let clinicId: string;
  const storage = new FakeStorageProvider();
  const run = <T>(fn: (c: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Estimate Dental",
        owner: { name: "Dr. E", phone: "9835000061" },
      }));
      await client.query(
        "update procedure_types set price_min_paise = 400000, price_max_paise = 400000 where clinic_id = $1 and code = 'rct_sitting'",
        [clinicId],
      );
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("an estimate from a plan groups identical sittings and totals them", async () => {
    const p = await run((c) => createPatient(c, { name: "सुनीता देवी", phone: "+919000300001" }));
    const tpl = await run(
      async (c) => (await c.query("select id from treatment_templates where code = 'rct'")).rows[0].id,
    );
    const plan = await run((c) => createTreatmentPlan(c, { patientId: p.id, templateId: tpl, now: NOW }));
    const est = await run((c) => estimateFromPlan(c, plan.id, { now: NOW }));
    expect(est.totalPaise).toBe(1200000);
    const [row] = await run((c) => patientEstimates(c, p.id));
    expect(row.items).toEqual([
      {
        label: "Root canal (RCT) sitting",
        procedure_type_id: expect.any(String),
        tooth: null,
        qty: 3,
        amount_paise: 400000,
      },
    ]);
    expect(row.valid_until).toBe("2030-02-06");

    // Sending: a PDF in storage and a WhatsApp message with the total, a link and two buttons.
    const { outboxId } = await run((c) => sendEstimate(c, est.id, { storage, now: NOW }));
    const msg = (await db.pool.query("select payload, category from outbox where id = $1", [outboxId]))
      .rows[0];
    expect(msg.payload.params.slice(0, 3)).toEqual(["सुनीता देवी", "Estimate Dental", "₹12,000"]);
    expect(msg.payload.buttonPayloads).toEqual([`estimate_ok:${est.id}`, `estimate_call:${est.id}`]);
    const stored = await storage.get(`estimates/${clinicId}/${est.id}.pdf`);
    expect(stored?.contentType).toBe("application/pdf");
    const pdf = await PDFDocument.load(stored!.bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toMatch(/^Estimate /);
    // Sending again does not queue a second message.
    expect((await run((c) => sendEstimate(c, est.id, { storage, now: NOW }))).outboxId).toBeNull();

    // Accepting the estimate accepts the plan.
    await run((c) => decideEstimate(c, est.id, "accepted"));
    expect((await run((c) => patientPlans(c, p.id)))[0]!.status).toBe("accepted");
    await expect(run((c) => decideEstimate(c, est.id, "declined"))).rejects.toThrow(/already decided/);
  });

  it("validates items and expires old estimates", async () => {
    const p = await run((c) => createPatient(c, { name: "Amit", phone: "+919000300002" }));
    await expect(run((c) => createEstimate(c, { patientId: p.id, items: [] }))).rejects.toThrow(
      /at least one/,
    );
    await expect(
      run((c) => createEstimate(c, { patientId: p.id, items: [{ label: "x", qty: 0, amountPaise: 100 }] })),
    ).rejects.toThrow(/quantity/);
    const e = await run((c) =>
      createEstimate(c, {
        patientId: p.id,
        items: [{ label: "Braces", qty: 1, amountPaise: 3500000 }],
        emiNote: "EMI available",
        validDays: 10,
        now: NOW,
      }),
    );
    expect(
      await run((c) => expireEstimates(c, new Date("2030-01-20T10:00:00+05:30"))),
    ).toBeGreaterThanOrEqual(1);
    expect((await run((c) => patientEstimates(c, p.id))).find((r) => r.id === e.id).status).toBe("expired");
  });

  it("renders Hindi names and the rupee sign safely in the PDF", async () => {
    const bytes = await renderEstimatePdf({
      clinic: { name: "शर्मा डेंटल", address: "Lalpur, Ranchi", phone: "0651 2345678" },
      patientName: "रमेश कुमार",
      number: "AB12",
      date: "2030-01-07",
      validUntil: "2030-02-06",
      items: [{ label: "₹ Implant", tooth: "36", qty: 1, amountPaise: 2500000 }],
      totalPaise: 2500000,
      emiNote: null,
      doctor: null,
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});

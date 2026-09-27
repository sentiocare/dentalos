import { FakeStorageProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookDirect } from "../scheduling/service";
import {
  cancelPrescription,
  isTooth,
  listNotes,
  listPrescriptions,
  listRxTemplates,
  recordTooth,
  renderPrescriptionPdf,
  saveNote,
  saveRxTemplate,
  sendPrescription,
  toothChart,
  writePrescription,
} from "./clinical";

describe.skipIf(!hasTestDatabase)("clinical record: notes, tooth chart, prescriptions", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "system", role: "doctor" }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
    await db.pool.query(
      "update doctors set qualification = 'BDS, MDS', registration_no = 'JH-1234' where id = $1",
      [c.doctorIds[0]],
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("one note per visit: saving again updates it; a note needs some text", async () => {
    const { appointment } = await run((cl) =>
      bookDirect(cl, {
        patientId: c.patientIds[0]!,
        doctorId: c.doctorIds[0]!,
        chairId: c.chairIds[0]!,
        procedureTypeId: c.procedureId,
        startsAt: new Date("2030-03-12T10:00:00+05:30"),
        acknowledgeWarnings: true,
        now: new Date("2030-03-01T10:00:00+05:30"),
      }),
    );
    const first = await run((cl) =>
      saveNote(cl, {
        patientId: c.patientIds[0]!,
        appointmentId: appointment.id,
        doctorId: c.doctorIds[0],
        complaint: "Pain in lower left since 3 days",
        diagnosis: "Deep caries 36",
      }),
    );
    const again = await run((cl) =>
      saveNote(cl, {
        patientId: c.patientIds[0]!,
        appointmentId: appointment.id,
        complaint: "Pain in lower left since 3 days",
        diagnosis: "Irreversible pulpitis 36",
        treatment: "Access opening, RCT started",
      }),
    );
    expect(again.id).toBe(first.id);
    const notes = await run((cl) => listNotes(cl, c.patientIds[0]!));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ diagnosis: "Irreversible pulpitis 36", doctorName: "Dr. Sharma" });
    // The same visit can't carry another patient's note.
    await expect(
      run((cl) =>
        saveNote(cl, { patientId: c.patientIds[1]!, appointmentId: appointment.id, complaint: "x" }),
      ),
    ).rejects.toThrow(/another patient/);
    await expect(run((cl) => saveNote(cl, { patientId: c.patientIds[0]!, complaint: "  " }))).rejects.toThrow(
      /Write something/,
    );
    // Edits are in the audit log with what the note said before.
    const audit = await db.pool.query(
      "select before->>'diagnosis' as before from audit_log where entity = 'clinical_notes' and action = 'update'",
    );
    expect(audit.rows[0].before).toBe("Deep caries 36");
  });

  it("the chart shows each tooth's latest finding and keeps the history", async () => {
    expect([11, 18, 48, 55, 85].every(isTooth)).toBe(true);
    expect([10, 19, 49, 56, 91].some(isTooth)).toBe(false);
    await run((cl) =>
      recordTooth(cl, { patientId: c.patientIds[0]!, tooth: 36, condition: "caries", surfaces: "o, d" }),
    );
    await run((cl) => recordTooth(cl, { patientId: c.patientIds[0]!, tooth: 36, condition: "rct" }));
    await run((cl) => recordTooth(cl, { patientId: c.patientIds[0]!, tooth: 48, condition: "impacted" }));
    await expect(
      run((cl) => recordTooth(cl, { patientId: c.patientIds[0]!, tooth: 19, condition: "caries" })),
    ).rejects.toThrow(/not a tooth/);
    const chart = await run((cl) => toothChart(cl, c.patientIds[0]!));
    expect(chart.teeth[36]!.condition).toBe("rct");
    expect(chart.teeth[48]!.condition).toBe("impacted");
    expect(chart.history.filter((f) => f.tooth === 36).map((f) => f.condition)).toEqual(["rct", "caries"]);
    expect(chart.history.find((f) => f.condition === "caries")!.surfaces).toBe("OD");
  });

  it("prescriptions: numbered, from a template, never changed, cancelled with a reason, printed and sent", async () => {
    await run((cl) =>
      saveRxTemplate(cl, {
        name: "After extraction",
        doctorId: c.doctorIds[0],
        items: [
          {
            drug: "Amoxicillin 500 mg",
            dose: "1 cap",
            frequency: "1-1-1",
            duration: "5 days",
            instructions: "after food",
          },
          { drug: "Paracetamol 650 mg", dose: "1 tab", frequency: "SOS", duration: "3 days" },
          { drug: "  " },
        ],
        advice: "Cold food only today. No spitting.",
      }),
    );
    const [template] = await run(listRxTemplates);
    expect(template!.items).toHaveLength(2);

    const rx = await run((cl) =>
      writePrescription(cl, {
        patientId: c.patientIds[0]!,
        doctorId: c.doctorIds[0]!,
        items: template!.items,
        advice: template!.advice,
        reviewOn: "2030-03-19",
        now: new Date("2030-03-12T11:00:00+05:30"),
      }),
    );
    expect(rx.number).toBe("RX/2029-30/0001");
    const second = await run((cl) =>
      writePrescription(cl, {
        patientId: c.patientIds[0]!,
        doctorId: c.doctorIds[0]!,
        items: [{ drug: "Chlorhexidine mouthwash", frequency: "twice a day" }],
        now: new Date("2030-03-12T11:05:00+05:30"),
      }),
    );
    expect(second.number).toBe("RX/2029-30/0002");
    await expect(
      run((cl) =>
        writePrescription(cl, { patientId: c.patientIds[0]!, doctorId: c.doctorIds[0]!, items: [] }),
      ),
    ).rejects.toThrow(/at least one/);

    await expect(
      db.pool.query(`update prescriptions set items = '[{"drug":"x"}]' where id = $1`, [rx.id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(db.pool.query("delete from prescriptions where id = $1", [rx.id])).rejects.toThrow();
    await run((cl) => cancelPrescription(cl, second.id, "Wrong patient"));
    await expect(run((cl) => cancelPrescription(cl, second.id, "again"))).rejects.toThrow(
      /Already cancelled/,
    );
    const list = await run((cl) => listPrescriptions(cl, c.patientIds[0]!));
    expect(list.map((p) => [p.number, p.cancelReason])).toEqual([
      ["RX/2029-30/0002", "Wrong patient"],
      ["RX/2029-30/0001", null],
    ]);

    const pdf = await run((cl) => renderPrescriptionPdf(cl, rx.id));
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
    const storage = new FakeStorageProvider();
    const sent = await run((cl) => sendPrescription(cl, rx.id, { storage }));
    expect(sent.outboxId).toBeTruthy();
    const out = (await db.pool.query("select purpose, payload from outbox where id = $1", [sent.outboxId]))
      .rows[0];
    expect(out.purpose).toBe("prescription");
    expect(out.payload.params.slice(0, 3)).toEqual(["Ramesh Kumar", "Dr. Sharma", "Test Dental"]);
    await expect(run((cl) => sendPrescription(cl, second.id, { storage }))).rejects.toThrow(/cancelled/);
  });
});

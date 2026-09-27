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
import {
  commitAppointmentImport,
  guessAppointmentMapping,
  parseClockTime,
  previewAppointmentImport,
} from "../scheduling/import";
import { listAppointments } from "../scheduling/queries";
import {
  commitPatientImport,
  createPatient,
  getPatient,
  linkFamily,
  listFamily,
  previewPatientImport,
  searchPatients,
  updatePatient,
} from "./service";

describe("parseClockTime", () => {
  it.each([
    ["5 pm", 17 * 60],
    ["5:30 PM", 17 * 60 + 30],
    ["17:30", 17 * 60 + 30],
    ["10.15", 10 * 60 + 15],
    ["12 pm", 12 * 60],
    ["5", 17 * 60],
    ["11", 11 * 60],
  ])("%s", (input, minutes) => expect(parseClockTime(input)).toBe(minutes));
  it.each(["25:00", "13 pm", "abc", "10:75"])("rejects %s", (input) =>
    expect(parseClockTime(input)).toBeNull(),
  );
});

describe.skipIf(!hasTestDatabase)("patients and imports (database)", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "user:test", role: "receptionist" }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("creates, normalises and updates patients", async () => {
    const p = await run((cl) =>
      createPatient(cl, {
        name: "  Kamla   Devi ",
        phone: "98765 11111",
        approxBirthYear: 1955,
        gender: "female",
      }),
    );
    expect(p.name).toBe("Kamla Devi");
    expect(p.phone).toBe("+919876511111");
    await expect(run((cl) => createPatient(cl, { name: "X", phone: "123" }))).rejects.toMatchObject({
      code: "invalid",
    });
    const u = await run((cl) => updatePatient(cl, p.id, { city: "Ranchi", phone: "+91 98765 22222" }));
    expect(u).toMatchObject({ city: "Ranchi", phone: "+919876522222" });
  });

  it("searches by phone digits, name prefix and misspelling", async () => {
    await run((cl) =>
      createPatient(cl, { name: "Mahendra Singh", phone: "9431012345", fileNumber: "OPD-77" }),
    );
    expect((await run((cl) => searchPatients(cl, "12345")))[0]?.name).toBe("Mahendra Singh");
    expect((await run((cl) => searchPatients(cl, "943 101 2345")))[0]?.name).toBe("Mahendra Singh");
    expect((await run((cl) => searchPatients(cl, "mahen")))[0]?.name).toBe("Mahendra Singh");
    expect((await run((cl) => searchPatients(cl, "Mahindra Sing")))[0]?.name).toBe("Mahendra Singh");
    expect((await run((cl) => searchPatients(cl, "OPD-77")))[0]?.name).toBe("Mahendra Singh");
  });

  it("links family members in both directions", async () => {
    const mother = await run((cl) => createPatient(cl, { name: "Savitri Devi", phone: "9431099999" }));
    const son = await run((cl) => createPatient(cl, { name: "Amit Kumar", phone: "9431099999" }));
    await run((cl) =>
      linkFamily(cl, { patientId: son.id, relatedPatientId: mother.id, relationship: "Mother" }),
    );
    expect(await run((cl) => listFamily(cl, son.id))).toMatchObject([
      { name: "Savitri Devi", relationship: "mother", direction: "outgoing" },
    ]);
    expect(await run((cl) => listFamily(cl, mother.id))).toMatchObject([
      { name: "Amit Kumar", direction: "incoming" },
    ]);
  });

  it("imports 5,000 patients with duplicates merged, in a few seconds, and search stays fast", async () => {
    const existing = await run((cl) => createPatient(cl, { name: "Existing Person", phone: "9000000001" }));
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      Naam: i === 0 ? "Existing Person" : `Import Patient ${i % 4800}`,
      Mobile: i === 0 ? "9000000001" : `97${String(10_000_000 + (i % 4800)).padStart(8, "0")}`,
      Umar: String(20 + (i % 60)),
      City: i === 0 ? "Hazaribagh" : "Ranchi",
    }));
    const started = performance.now();
    const preview = await run((cl) =>
      previewPatientImport(
        cl,
        rows,
        { name: "Naam", phone: "Mobile", age: "Umar", city: "City" },
        "2026-09-27",
      ),
    );
    expect(preview.filter((p) => p.action === "merge")).toHaveLength(1);
    expect(preview.filter((p) => p.action === "skip")).toHaveLength(199);
    const result = await run((cl) =>
      commitPatientImport(
        cl,
        preview.map((p) => ({ action: p.action, value: p.value, mergeIntoId: p.duplicateOf?.id })),
      ),
    );
    expect(result).toEqual({ created: 4800, merged: 1, skipped: 199 });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect((await run((cl) => getPatient(cl, existing.id))).city).toBe("Hazaribagh");

    const searchStart = performance.now();
    const found = await run((cl) => searchPatients(cl, "Import Patient 4321"));
    expect(performance.now() - searchStart).toBeLessThan(1000);
    expect(found[0]?.name).toBe("Import Patient 4321");
  });

  it("imports appointments: matches doctors and procedures by name, creates patients, reports clashes, never duplicates", async () => {
    const headers = ["Date", "Time", "Patient Name", "Mobile", "Doctor", "Treatment"];
    const mapping = guessAppointmentMapping(headers);
    expect(mapping).toEqual({
      date: "Date",
      time: "Time",
      patientName: "Patient Name",
      phone: "Mobile",
      doctor: "Doctor",
      procedure: "Treatment",
    });
    const rows = [
      {
        Date: "10/03/2031",
        Time: "10:00 AM",
        "Patient Name": "Ram Prasad",
        Mobile: "9835011111",
        Doctor: "Dr Sharma",
        Treatment: "scaling",
      },
      {
        Date: "10/03/2031",
        Time: "10:00 AM",
        "Patient Name": "Shyam Lal",
        Mobile: "9835022222",
        Doctor: "sharma",
        Treatment: "Scaling",
      },
      {
        Date: "10/03/2031",
        Time: "10:00 AM",
        "Patient Name": "Geeta",
        Mobile: "9835033333",
        Doctor: "Dr. Sharma",
      },
      { Date: "31/02/2031", Time: "10", "Patient Name": "Bad Date", Mobile: "9835044444", Doctor: "Verma" },
      {
        Date: "05/01/2020",
        Time: "5 pm",
        "Patient Name": "Old Visit",
        Mobile: "9835055555",
        Doctor: "Verma",
      },
    ];
    const preview = await run((cl) => previewAppointmentImport(cl, rows, mapping, "2026-09-27"));
    expect(preview.map((p) => p.importable)).toEqual([true, true, true, false, true]);
    expect(preview[3]!.issues).toEqual(["invalid_date"]);

    const results = await run((cl) => commitAppointmentImport(cl, preview, new Date("2026-09-27T06:00:00Z")));
    // Rows 2 and 3 want Dr. Sharma at the same time as row 1, so they clash and are reported.
    expect(results.map((r) => r.status)).toEqual(["booked", "conflict", "conflict", "error", "booked"]);

    const again = await run((cl) => commitAppointmentImport(cl, preview, new Date("2026-09-27T06:00:00Z")));
    expect(again.map((r) => r.status)).toEqual([
      "already_imported",
      "conflict",
      "conflict",
      "error",
      "already_imported",
    ]);

    const history = await run((cl) =>
      listAppointments(cl, { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2020-01-31T00:00:00Z") }),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "completed",
      patient: { name: "Old Visit" },
      doctor: { name: "Dr. Verma" },
    });
  });
});

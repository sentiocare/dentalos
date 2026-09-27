import { createAdapters } from "@dentalos/adapters";
import { createClinic, MemoryJobQueue } from "@dentalos/core";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = {
  jwtSecret: "test-secret-that-is-long-enough-1234567890",
  audience: "authenticated",
  devLogin: true,
};

describe.skipIf(!hasTestDatabase)("clinical record API", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let owner: string;
  let reception: string;
  const login = async (phone: string) =>
    (await app.inject({ method: "POST", url: "/v1/dev/login", payload: { phone } })).json().token as string;
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      await createClinic(client, {
        name: "Clinical API Dental",
        owner: { name: "Dr. O", phone: "9835000191" },
      });
    } finally {
      client.release();
    }
    app = buildApp({
      pool: db.pool,
      adapters: createAdapters({
        messaging: "fake",
        telephony: "fake",
        voice: "fake",
        llm: "fake",
        payments: "fake",
        sms: "fake",
        storage: "fake",
      }),
      logger,
      version: "test",
      auth,
      jobs: new MemoryJobQueue(),
      channelKey: Buffer.alloc(32, 9),
    });
    owner = await login("9835000191");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", {
      phone: "98350 00192",
      name: "Reception",
      role: "receptionist",
    });
    reception = await login("9835000192");
    await call(reception, "GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("doctors write notes, the chart and prescriptions; reception can't see them unless allowed", async () => {
    const doctor = (
      await call(owner, "POST", "/v1/doctors", {
        name: "Dr. Rx",
        kind: "permanent",
        qualification: "BDS",
        registrationNo: "JH-42",
      })
    ).json();
    expect(doctor).toMatchObject({ qualification: "BDS", registration_no: "JH-42" });
    const patient = (
      await call(owner, "POST", "/v1/patients", { name: "Rx Patient", phone: "98111 77701" })
    ).json();
    const base = `/v1/patients/${patient.id}`;

    expect(
      (await call(owner, "POST", `${base}/notes`, { complaint: "Sensitivity", diagnosis: "Attrition" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(owner, "POST", `${base}/teeth`, { tooth: 16, condition: "caries", surfaces: "o" }))
        .statusCode,
    ).toBe(200);
    expect((await call(owner, "POST", `${base}/teeth`, { tooth: 16, condition: "gone" })).statusCode).toBe(
      400,
    );
    const rx = (
      await call(owner, "POST", `${base}/prescriptions`, {
        doctorId: doctor.id,
        items: [{ drug: "Potassium nitrate toothpaste", frequency: "twice a day", duration: "4 weeks" }],
        send: true,
      })
    ).json();
    expect(rx).toMatchObject({ number: expect.stringMatching(/^RX\/\d{4}-\d{2}\/0001$/), sent: true });
    const pdf = await call(owner, "GET", `/v1/prescriptions/${rx.id}/pdf`);
    expect(pdf.headers["content-type"]).toBe("application/pdf");

    const record = (await call(owner, "GET", `${base}/clinical`)).json();
    expect(record.notes[0]).toMatchObject({ diagnosis: "Attrition" });
    expect(record.chart.teeth["16"]).toMatchObject({ condition: "caries", surfaces: "O" });
    expect(record.prescriptions).toHaveLength(1);

    expect((await call(reception, "GET", `${base}/clinical`)).statusCode).toBe(403);
    expect((await call(reception, "GET", `/v1/prescriptions/${rx.id}/pdf`)).statusCode).toBe(403);
    const staff = (await call(owner, "GET", "/v1/staff")).json();
    const rec = staff.find((s: { display_name: string }) => s.display_name === "Reception");
    // Writing clinical records can't be granted to reception; reading can.
    expect(
      (await call(owner, "PATCH", `/v1/staff/${rec.id}`, { permissions: { "clinical.write": true } }))
        .statusCode,
    ).toBe(400);
    await call(owner, "PATCH", `/v1/staff/${rec.id}`, { permissions: { "clinical.read": true } });
    expect((await call(reception, "GET", `${base}/clinical`)).statusCode).toBe(200);
    expect((await call(reception, "GET", `/v1/prescriptions/${rx.id}/pdf`)).statusCode).toBe(200);
    // Reading can be allowed; writing a prescription never is.
    expect(
      (
        await call(reception, "POST", `${base}/prescriptions`, {
          doctorId: doctor.id,
          items: [{ drug: "Anything" }],
        })
      ).statusCode,
    ).toBe(403);
  });
});

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

describe.skipIf(!hasTestDatabase)("front desk API", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let owner: string;
  let assistant: string;
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
      await createClinic(client, { name: "Desk API Dental", owner: { name: "Dr. O", phone: "9835000181" } });
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
    owner = await login("9835000181");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", {
      phone: "98350 00182",
      name: "Chair assistant",
      role: "assistant",
    });
    assistant = await login("9835000182");
    await call(assistant, "GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("walk-in: token, send in, done, bill and pay; the desk shows it paid", async () => {
    const doctor = (await call(owner, "POST", "/v1/doctors", { name: "Dr. Desk", kind: "permanent" })).json();
    const chair = (await call(owner, "POST", "/v1/chairs", { name: "Chair 9", equipment: [] })).json();
    const patient = (
      await call(owner, "POST", "/v1/patients", { name: "Walk In", phone: "98111 66601" })
    ).json();

    const walkIn = (await call(owner, "POST", "/v1/queue", { patientId: patient.id, note: "Pain" })).json();
    expect(walkIn.token).toBe(1);
    expect((await call(owner, "POST", "/v1/queue", { patientId: patient.id })).statusCode).toBe(409);

    let desk = (await call(owner, "GET", "/v1/desk")).json();
    expect(desk.queue).toEqual([
      expect.objectContaining({ token: 1, status: "waiting", walkIn: true, note: "Pain", doctor: null }),
    ]);
    expect(desk.assistant).toEqual({ calls: 0, booked: 0, chats: 0, reminders: 0, emergencies: 0 });

    expect(
      (await call(owner, "POST", `/v1/queue/${walkIn.id}/send-in`, { chairId: chair.id })).statusCode,
    ).toBe(400);
    const sent = (
      await call(owner, "POST", `/v1/queue/${walkIn.id}/send-in`, { doctorId: doctor.id, chairId: chair.id })
    ).json();
    expect(
      (await call(owner, "POST", `/v1/appointments/${sent.appointmentId}/status`, { status: "completed" }))
        .statusCode,
    ).toBe(200);

    const checkout = (await call(owner, "GET", `/v1/appointments/${sent.appointmentId}/checkout`)).json();
    expect(checkout).toMatchObject({ patient: { name: "Walk In" }, chargedPaise: 0, balancePaise: 0 });
    await call(owner, "POST", `/v1/patients/${patient.id}/charges`, {
      amountPaise: 50000,
      description: "Check-up",
      appointmentId: sent.appointmentId,
    });
    await call(owner, "POST", `/v1/patients/${patient.id}/payments`, {
      amountPaise: 50000,
      method: "cash",
      appointmentId: sent.appointmentId,
    });
    desk = (await call(owner, "GET", "/v1/desk")).json();
    expect(desk.queue[0]).toMatchObject({ status: "done", appointmentId: sent.appointmentId });
    expect(desk.billing[sent.appointmentId]).toEqual({ chargedPaise: 50000, paidPaise: 50000 });
    expect((await call(owner, "GET", "/v1/desk/counts")).json()).toEqual({
      tasks: 0,
      critical: 0,
      unread: 0,
      leads: 0,
    });
  });

  it("a chair-side assistant sees the queue but not money, and can't bill", async () => {
    const desk = (await call(assistant, "GET", "/v1/desk")).json();
    expect(desk.queue.length).toBe(1);
    expect(desk.billing).toBeNull();
    expect(
      (await call(assistant, "GET", `/v1/appointments/${desk.queue[0].appointmentId}/checkout`)).statusCode,
    ).toBe(403);
  });
});

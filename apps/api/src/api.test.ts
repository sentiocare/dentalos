import { createAdapters } from "@dentalos/adapters";
import { createClinic } from "@dentalos/core";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryJobQueue } from "@dentalos/core";
import { buildApp } from "./app";

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = {
  jwtSecret: "test-secret-that-is-long-enough-1234567890",
  audience: "authenticated",
  devLogin: true,
};
const fakes = () =>
  createAdapters({
    messaging: "fake",
    telephony: "fake",
    voice: "fake",
    llm: "fake",
    payments: "fake",
    sms: "fake",
    storage: "fake",
  });

describe.skipIf(!hasTestDatabase)("staff API", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  const jobs = new MemoryJobQueue();
  let clinicA: string;
  let clinicB: string;

  const login = async (phone: string) => {
    const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { phone } });
    return res.json().token as string;
  };
  const call = (token: string, method: string, url: string, payload?: unknown, clinicId?: string) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}`, ...(clinicId ? { "x-clinic-id": clinicId } : {}) },
    });

  let owner: string;
  let reception: string;
  let ownerB: string;

  beforeAll(async () => {
    db = await createTestDatabase({ max: 25 });
    const client = await db.pool.connect();
    try {
      clinicA = (
        await createClinic(client, {
          name: "Sharma Dental",
          owner: { name: "Dr. Sharma", phone: "9835000001" },
        })
      ).clinicId;
      clinicB = (
        await createClinic(client, {
          name: "Other Dental",
          owner: { name: "Dr. Other", phone: "9835000009" },
        })
      ).clinicId;
    } finally {
      client.release();
    }
    app = buildApp({
      pool: db.pool,
      adapters: fakes(),
      logger,
      version: "test",
      auth,
      jobs,
      channelKey: null,
    });
    owner = await login("9835000001");
    ownerB = await login("9835000009");
    reception = await login("9835000002");
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("rejects missing and forged tokens", async () => {
    expect((await app.inject("/v1/me")).statusCode).toBe(401);
    const forged = await call("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc", "GET", "/v1/me");
    expect(forged.statusCode).toBe(401);
  });

  it("owner signs in with their phone and is connected to the clinic automatically", async () => {
    const me = (await call(owner, "GET", "/v1/me")).json();
    expect(me.clinics).toEqual([
      { id: clinicA, name: "Sharma Dental", role: "owner", displayName: "Dr. Sharma" },
    ]);
    const perms = (await call(owner, "GET", "/v1/me/permissions")).json();
    expect(perms.permissions).toContain("staff.manage");
  });

  it("someone not invited sees no clinic", async () => {
    await call(reception, "GET", "/v1/me");
    const res = await call(reception, "GET", "/v1/patients");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("no_clinic");
  });

  it("owner adds a receptionist, who can then work but not change settings", async () => {
    const added = await call(owner, "POST", "/v1/staff", {
      phone: "98350 00002",
      name: "Priya",
      role: "receptionist",
    });
    expect(added.statusCode).toBe(200);
    await call(reception, "GET", "/v1/me");
    expect((await call(reception, "GET", "/v1/patients")).statusCode).toBe(200);
    const settings = await call(reception, "PATCH", "/v1/clinic", { name: "Hacked" });
    expect(settings.statusCode).toBe(403);
    expect((await call(reception, "GET", "/v1/staff")).statusCode).toBe(403);
  });

  it("the clinic can never lose its last owner", async () => {
    const staff = (await call(owner, "GET", "/v1/staff")).json() as { id: string; role: string }[];
    const ownerRow = staff.find((s) => s.role === "owner")!;
    const res = await call(owner, "PATCH", `/v1/staff/${ownerRow.id}`, { role: "receptionist" });
    expect(res.statusCode).toBe(409);
  });

  it("configuration: add a visiting orthodontist, prices, and read it all back in one call", async () => {
    const ortho = (
      await call(owner, "POST", "/v1/doctors", {
        name: "Dr. Mehta",
        kind: "visiting",
        speciality: "Orthodontist",
      })
    ).json();
    expect(
      (
        await call(owner, "PUT", `/v1/doctors/${ortho.id}/visiting`, {
          windows: [{ weekday: 2, start: "11:00", end: "17:00" }],
        })
      ).statusCode,
    ).toBe(200);
    const config = (await call(reception, "GET", "/v1/config")).json();
    const braces = config.procedures.find((p: { code: string }) => p.code === "ortho_adjustment");
    const res = await call(owner, "PATCH", `/v1/procedures/${braces.id}`, {
      allowedDoctorIds: [ortho.id],
      priceMinPaise: 100000,
      priceMaxPaise: 50000,
    });
    expect(res.statusCode).toBe(400);
    expect(
      (
        await call(owner, "PATCH", `/v1/procedures/${braces.id}`, {
          allowedDoctorIds: [ortho.id],
          priceMinPaise: 50000,
          priceMaxPaise: 100000,
          pricePublic: true,
        })
      ).statusCode,
    ).toBe(200);
    const again = (await call(reception, "GET", "/v1/config")).json();
    expect(again.visiting).toHaveLength(1);
    expect(again.workingHours.length).toBe(12);
    expect(again.procedures.length).toBeGreaterThan(15);
  });

  describe("booking over HTTP", () => {
    let patientId: string;
    let doctorId: string;
    let chairId: string;
    let procedureId: string;
    const start = "2031-03-11T10:00:00+05:30"; // a Tuesday

    beforeAll(async () => {
      patientId = (
        await call(reception, "POST", "/v1/patients", { name: "Ramesh Kumar", phone: "9876543210" })
      ).json().id;
      const config = (await call(reception, "GET", "/v1/config")).json();
      doctorId = (await call(owner, "POST", "/v1/doctors", { name: "Dr. Sharma" })).json().id;
      chairId = config.chairs[0].id;
      procedureId = config.procedures.find((p: { code: string }) => p.code === "scaling").id;
    });

    it("staff changes trigger the patient's confirmation planning", async () => {
      jobs.jobs.length = 0;
      await call(reception, "POST", "/v1/appointments", {
        patientId,
        doctorId,
        chairId,
        startsAt: "2031-03-12T10:00:00+05:30",
        endsAt: "2031-03-12T10:30:00+05:30",
      });
      expect(jobs.jobs.some((j) => j.task === "plan_messages")).toBe(true);
    });

    it("books, and 20 simultaneous requests for the same slot give exactly one success", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 20 }, () =>
          call(reception, "POST", "/v1/appointments", {
            patientId,
            doctorId,
            chairId,
            procedureTypeId: procedureId,
            startsAt: start,
          }),
        ),
      );
      const codes = attempts.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(19);
      expect(attempts.find((r) => r.statusCode === 409)!.json().error).toBe("slot_taken");
    });

    it("a retried request with the same idempotency key returns the same booking", async () => {
      const body = {
        patientId,
        doctorId,
        chairId,
        startsAt: "2031-03-11T11:00:00+05:30",
        endsAt: "2031-03-11T11:30:00+05:30",
        idempotencyKey: "tap-123456",
      };
      const first = (await call(reception, "POST", "/v1/appointments", body)).json();
      const second = (await call(reception, "POST", "/v1/appointments", body)).json();
      expect(second.appointment.id).toBe(first.appointment.id);
    });

    it("asks for confirmation outside hours, moves, and cancels", async () => {
      const outside = await call(reception, "POST", "/v1/appointments", {
        patientId,
        doctorId,
        chairId,
        procedureTypeId: procedureId,
        startsAt: "2031-03-11T15:00:00+05:30",
      });
      expect(outside.statusCode).toBe(409);
      expect(outside.json()).toMatchObject({
        error: "needs_confirmation",
        warnings: ["outside_working_hours"],
      });

      const booked = (
        await call(reception, "POST", "/v1/appointments", {
          patientId,
          doctorId,
          chairId,
          procedureTypeId: procedureId,
          startsAt: "2031-03-11T12:00:00+05:30",
        })
      ).json();
      const moved = await call(reception, "PATCH", `/v1/appointments/${booked.appointment.id}`, {
        startsAt: "2031-03-11T12:30:00+05:30",
      });
      expect(moved.statusCode).toBe(200);
      const clash = await call(reception, "PATCH", `/v1/appointments/${booked.appointment.id}`, {
        startsAt: "2031-03-11T10:15:00+05:30",
      });
      expect(clash.json().error).toBe("slot_taken");
      expect(
        (
          await call(reception, "POST", `/v1/appointments/${booked.appointment.id}/cancel`, {
            reason: "patient called",
          })
        ).json().status,
      ).toBe("cancelled");

      const list = (
        await call(
          reception,
          "GET",
          "/v1/appointments?from=2031-03-11T00:00:00%2B05:30&to=2031-03-12T00:00:00%2B05:30",
        )
      ).json();
      expect(list.map((a: { patient: { name: string } }) => a.patient.name)).toEqual([
        "Ramesh Kumar",
        "Ramesh Kumar",
      ]);
    });

    it("finds free slots within the booking horizon only", async () => {
      // A weekday 10–16 days from now (inside the 60-day horizon).
      const d = new Date(Date.now() + 10 * 86_400_000);
      while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      const day = d.toISOString().slice(0, 10);
      const slots = (
        await call(
          reception,
          "GET",
          `/v1/slots?procedureId=${procedureId}&fromDate=${day}&toDate=${day}&partsOfDay=morning`,
        )
      ).json();
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].start).toBe(new Date(`${day}T10:00:00+05:30`).toISOString());
      const far = (
        await call(
          reception,
          "GET",
          `/v1/slots?procedureId=${procedureId}&fromDate=2031-03-11&toDate=2031-03-11`,
        )
      ).json();
      expect(far).toEqual([]);
    });

    it("another clinic cannot see or touch this clinic's patients", async () => {
      expect((await call(ownerB, "GET", "/v1/me")).json().clinics[0].id).toBe(clinicB);
      expect((await call(ownerB, "GET", `/v1/patients/${patientId}`)).statusCode).toBe(404);
      expect((await call(ownerB, "PATCH", `/v1/patients/${patientId}`, { name: "x" })).statusCode).toBe(404);
      expect((await call(ownerB, "GET", "/v1/patients?q=Ramesh")).json()).toEqual([]);
      // Choosing someone else's clinic with the header is refused.
      expect((await call(ownerB, "GET", "/v1/patients", undefined, clinicA)).statusCode).toBe(400);
    });

    it("the audit log shows who did it", async () => {
      const log = (await call(owner, "GET", `/v1/audit?entity=patients&entityId=${patientId}`)).json();
      expect(log.at(-1)).toMatchObject({ action: "insert", actor_name: "Priya" });
      expect((await call(reception, "GET", "/v1/audit")).statusCode).toBe(403);
    });

    it("the owner can hide revenue from the receptionist", async () => {
      const staff = (await call(owner, "GET", "/v1/staff")).json() as { id: string; display_name: string }[];
      const priya = staff.find((s) => s.display_name === "Priya")!;
      const patched = await call(owner, "PATCH", `/v1/staff/${priya.id}`, {
        permissions: { "reports.revenue": false },
      });
      expect(patched.json()).toEqual({ ok: true });
      const perms = (await call(reception, "GET", "/v1/me/permissions")).json();
      expect(perms.permissions).not.toContain("reports.revenue");
    });
  });

  it("imports patients through preview and commit", async () => {
    const rows = [
      { Name: "Import One", Mobile: "9431000001", Age: "40" },
      { Name: "Import One", Mobile: "9431000001", Age: "40" },
      { Name: "", Mobile: "9431000003" },
    ];
    const preview = (await call(reception, "POST", "/v1/imports/patients/preview", { rows })).json();
    expect(preview.mapping).toEqual({ name: "Name", phone: "Mobile", age: "Age" });
    expect(preview.rows.map((r: { action: string }) => r.action)).toEqual(["create", "skip", "skip"]);
    const result = (
      await call(reception, "POST", "/v1/imports/patients/commit", {
        decisions: preview.rows.map((r: { action: string; value: unknown }) => ({
          action: r.action,
          value: r.value,
        })),
      })
    ).json();
    expect(result).toEqual({ created: 1, merged: 0, skipped: 2 });
  });

  it("validation errors name the field", async () => {
    const res = await call(reception, "POST", "/v1/patients", { phone: "9876543210" });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("name");
    const badPhone = await call(reception, "POST", "/v1/patients", { name: "X", phone: "12" });
    expect(badPhone.statusCode).toBe(400);
  });
});

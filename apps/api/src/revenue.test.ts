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

describe.skipIf(!hasTestDatabase)("revenue API: plans, estimates, follow-ups, campaigns", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let clinicId: string;
  let owner: string;
  let reception: string;
  let patientId: string;
  const jobs = new MemoryJobQueue();
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
      ({ clinicId } = await createClinic(client, {
        name: "Revenue Dental",
        owner: { name: "Dr. R", phone: "9835000091" },
      }));
      await client.query("insert into doctors (clinic_id, name) values ($1, 'Dr. R')", [clinicId]);
      await client.query(
        "update procedure_types set price_min_paise = 400000, price_max_paise = 400000 where clinic_id = $1 and code = 'rct_sitting'",
        [clinicId],
      );
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
      jobs,
      channelKey: null,
    });
    owner = await login("9835000091");
    await call(owner, "GET", "/v1/me");
    await call(owner, "POST", "/v1/staff", { phone: "98350 00092", name: "Reception", role: "receptionist" });
    reception = await login("9835000092");
    await call(reception, "GET", "/v1/me");
    patientId = (
      await call(owner, "POST", "/v1/patients", { name: "Gita Sharma", phone: "98765 11111" })
    ).json().id;
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("creates a plan from a template, shows it, and proposes the next sitting's free times", async () => {
    const templates = (await call(reception, "GET", "/v1/treatment-templates")).json();
    const rct = templates.find((t: { code: string }) => t.code === "rct");
    const start = new Date(Date.now() + 3 * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    const created = await call(reception, "POST", `/v1/patients/${patientId}/plans`, {
      templateId: rct.id,
      teeth: ["46"],
      status: "accepted",
      startDate: start,
    });
    expect(created.statusCode).toBe(200);
    const plans = (await call(reception, "GET", `/v1/patients/${patientId}/plans`)).json();
    expect(plans[0]).toMatchObject({
      title: "Root canal",
      status: "accepted",
      totalPaise: 1200000,
      teeth: ["46"],
    });
    const next = (await call(reception, "GET", `/v1/plans/${created.json().id}/next`)).json();
    expect(next.next).toMatchObject({ seq: 1, expected_from: start });
    expect(next.slots.length).toBeGreaterThan(0);
    expect(
      (await call(reception, "POST", `/v1/patients/${patientId}/plans`, { title: "Empty" })).statusCode,
    ).toBe(400);
  });

  it("incomplete treatments: values only for staff allowed to see revenue", async () => {
    const own = (await call(owner, "GET", "/v1/incomplete-treatments")).json();
    expect(own.totals).toMatchObject({ plans: 1, remainingPaise: 1200000 });
    // The owner switches revenue off for this receptionist.
    const staff = (await call(owner, "GET", "/v1/staff")).json();
    const rec = staff.find((s: { display_name: string }) => s.display_name === "Reception");
    await call(owner, "PATCH", `/v1/staff/${rec.id}`, { permissions: { "reports.revenue": false } });
    const theirs = (await call(reception, "GET", "/v1/incomplete-treatments")).json();
    expect(theirs.totals).toMatchObject({ plans: 1, remainingPaise: null });
    expect(theirs.rows[0].remainingPaise).toBeNull();
  });

  it("estimates: from a plan, sent on WhatsApp, PDF link, decision", async () => {
    const [plan] = (await call(reception, "GET", `/v1/patients/${patientId}/plans`)).json();
    const est = (await call(reception, "POST", `/v1/plans/${plan.id}/estimate`)).json();
    expect(est.totalPaise).toBe(1200000);
    expect((await call(reception, "GET", `/v1/estimates/${est.id}/pdf`)).statusCode).toBe(404);
    const sent = await call(reception, "POST", `/v1/estimates/${est.id}/send`);
    expect(sent.json()).toEqual({ ok: true, queued: true });
    expect(jobs.jobs.some((j) => j.task === "send_outbox")).toBe(true);
    expect((await call(reception, "GET", `/v1/estimates/${est.id}/pdf`)).json().url).toMatch(/^https:\/\//);
    expect(
      (await call(reception, "POST", `/v1/estimates/${est.id}/decision`, { decision: "declined" }))
        .statusCode,
    ).toBe(200);
    const list = (await call(reception, "GET", `/v1/patients/${patientId}/estimates`)).json();
    expect(list[0].status).toBe("declined");
    const manual = await call(reception, "POST", `/v1/patients/${patientId}/estimates`, {
      items: [{ label: "Braces", qty: 1, amountPaise: 3500000 }],
      emiNote: "EMI available",
    });
    expect(manual.json().totalPaise).toBe(3500000);
  });

  it("follow-ups: list, stop; ladders editable by the owner only; AI calls only for confirmations", async () => {
    await db.pool.query(
      "insert into followup_runs (clinic_id, kind, subject_type, subject_id, patient_id, phone, next_at) values ($1, 'no_show', 'appointment', gen_random_uuid(), $2, '+919876511111', now() + interval '1 hour')",
      [clinicId, patientId],
    );
    const active = (await call(reception, "GET", "/v1/followups?status=active")).json();
    expect(active).toHaveLength(1);
    expect(
      (await call(reception, "POST", `/v1/followups/${active[0].id}/stop`, { reason: "Patient called" }))
        .statusCode,
    ).toBe(200);
    expect((await call(reception, "POST", `/v1/followups/${active[0].id}/stop`)).statusCode).toBe(409);

    expect((await call(reception, "GET", "/v1/followup-ladders")).statusCode).toBe(403);
    const ladders = (await call(owner, "GET", "/v1/followup-ladders")).json();
    expect(ladders.map((l: { kind: string }) => l.kind)).toContain("recall");
    const bad = await call(owner, "PUT", "/v1/followup-ladders/recall", {
      active: true,
      steps: [{ afterHours: 0, action: "ai_call" }],
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call(owner, "PUT", "/v1/followup-ladders/recall", {
      active: true,
      steps: [
        { afterHours: 0, action: "whatsapp" },
        { afterHours: 240, atLocalTime: "10:00", action: "staff_task" },
      ],
    });
    expect(ok.statusCode).toBe(200);
    const recall = (await call(owner, "GET", "/v1/followup-ladders"))
      .json()
      .find((l: { kind: string }) => l.kind === "recall");
    expect(recall.steps[0]).toMatchObject({ action: "whatsapp", template: "recall" });
  });

  it("campaigns: wording check, owner approval, marketing consent", async () => {
    expect(
      (await call(owner, "POST", "/v1/campaigns/check-text", { text: "Best clinic in town!" })).json()
        .problems.length,
    ).toBe(1);
    const c = (
      await call(owner, "POST", "/v1/campaigns", {
        name: "Check-ups",
        inactiveMonths: 12,
        offerText: "We are open on Sundays this month.",
      })
    ).json();
    expect(c.problems).toEqual([]);
    expect((await call(owner, "POST", `/v1/campaigns/${c.id}/submit`)).statusCode).toBe(200);
    expect((await call(reception, "POST", `/v1/campaigns/${c.id}/approve`)).statusCode).toBe(403);
    expect((await call(owner, "POST", `/v1/campaigns/${c.id}/approve`)).statusCode).toBe(200);
    expect((await call(owner, "POST", `/v1/campaigns/${c.id}/run`)).json()).toEqual({
      queued: 0,
      noConsent: 0,
      optedOut: 0,
    });
    expect((await call(owner, "GET", "/v1/campaigns")).json()[0]).toMatchObject({
      status: "done",
      approved_by: "Dr. R",
    });
    expect(
      (await call(reception, "POST", `/v1/patients/${patientId}/marketing-consent`, { granted: true }))
        .statusCode,
    ).toBe(200);
    const consent = (
      await db.pool.query("select purpose, granted from consents where patient_id = $1", [patientId])
    ).rows;
    expect(consent).toEqual([{ purpose: "marketing", granted: true }]);
  });

  it("procedure settings accept recall, check-in, after-care and deposit", async () => {
    const procs = (await call(owner, "GET", "/v1/config")).json().procedures;
    const scaling = procs.find((p: { code: string }) => p.code === "scaling");
    const res = await call(owner, "PATCH", `/v1/procedures/${scaling.id}`, {
      recallMonths: 6,
      checkin: false,
      aftercare: { en: "Avoid very hot food today.", hi: "आज बहुत गरम खाना न खाएँ।", approved: true },
      depositPaise: 50000,
    });
    expect(res.statusCode).toBe(200);
    const row = (
      await db.pool.query(
        "select recall_months, aftercare, deposit_paise from procedure_types where id = $1",
        [scaling.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ recall_months: 6, deposit_paise: 50000, aftercare: { approved: true } });
  });
});

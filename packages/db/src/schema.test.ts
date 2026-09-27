import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withAppRole, withClinic, type ClinicContext } from "./client";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "./testing";

const T = (hhmm: string, day = "2026-10-06") => `${day}T${hhmm}:00+05:30`;

describe.skipIf(!hasTestDatabase)("clinic core schema", () => {
  let db: TestDatabase;
  let a: SeededClinic;
  let b: SeededClinic;
  let ctxA: ClinicContext;

  beforeAll(async () => {
    db = await createTestDatabase({ max: 25 });
    a = await seedMinimalClinic(db.pool, "Sharma Dental");
    b = await seedMinimalClinic(db.pool, "Other Dental");
    ctxA = { clinicId: a.clinicId, actor: "user:test", userId: undefined, role: "receptionist" };
  });

  afterAll(async () => {
    await db?.drop();
  });

  const book = (
    c: PoolClient,
    opts: {
      start: string;
      end: string;
      doctor?: number;
      chair?: number;
      patient?: number;
      buffer?: number;
      key?: string;
    },
  ) =>
    c.query(
      `insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at, buffer_min, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        a.clinicId,
        a.branchId,
        a.patientIds[opts.patient ?? 0],
        a.doctorIds[opts.doctor ?? 0],
        a.chairIds[opts.chair ?? 0],
        opts.start,
        opts.end,
        opts.buffer ?? 0,
        opts.key ?? null,
      ],
    );

  const inA = <R>(fn: (c: PoolClient) => Promise<R>) => withClinic(db.pool, ctxA, fn);

  describe("double booking is impossible at the database level", () => {
    it("records occupancy for both the doctor and the chair", async () => {
      const id = await inA(async (c) => (await book(c, { start: T("09:00"), end: T("09:30") })).rows[0].id);
      const { rows } = await db.pool.query(
        "select resource_kind from resource_occupancy where source_id = $1 order by 1",
        [id],
      );
      expect(rows.map((r) => r.resource_kind)).toEqual(["chair", "doctor"]);
    });

    it("rejects the same doctor at an overlapping time, even in a different chair", async () => {
      await expect(
        inA((c) => book(c, { start: T("09:15"), end: T("09:45"), chair: 1 })),
      ).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("rejects the same chair at an overlapping time, even with a different doctor", async () => {
      await expect(
        inA((c) => book(c, { start: T("09:20"), end: T("09:50"), doctor: 1 })),
      ).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("allows back-to-back appointments and parallel ones on other resources", async () => {
      await inA((c) => book(c, { start: T("09:30"), end: T("10:00") }));
      await inA((c) => book(c, { start: T("09:00"), end: T("09:30"), doctor: 1, chair: 1 }));
    });

    it("keeps the buffer after a procedure blocked", async () => {
      await inA((c) => book(c, { start: T("11:00"), end: T("11:30"), buffer: 10 }));
      await expect(inA((c) => book(c, { start: T("11:35"), end: T("12:00") }))).rejects.toMatchObject({
        code: "23P01",
      });
      await inA((c) => book(c, { start: T("11:40"), end: T("12:00") }));
    });

    it("frees the slot when cancelled or marked no-show, and re-blocks if reinstated", async () => {
      const id = await inA(async (c) => (await book(c, { start: T("13:00"), end: T("13:30") })).rows[0].id);
      await inA((c) => c.query("update appointments set status = 'cancelled' where id = $1", [id]));
      const other = await inA(
        async (c) => (await book(c, { start: T("13:00"), end: T("13:30"), patient: 1 })).rows[0].id,
      );
      await expect(
        inA((c) => c.query("update appointments set status = 'booked' where id = $1", [id])),
      ).rejects.toMatchObject({
        code: "23P01",
      });
      await inA((c) => c.query("update appointments set status = 'no_show' where id = $1", [other]));
      await inA((c) => c.query("update appointments set status = 'booked' where id = $1", [id]));
    });

    it("rejects moving an appointment onto an occupied slot, and allows moving to a free one", async () => {
      const id = await inA(async (c) => (await book(c, { start: T("15:00"), end: T("15:30") })).rows[0].id);
      await inA((c) => book(c, { start: T("16:00"), end: T("16:30") }));
      await expect(
        inA((c) =>
          c.query("update appointments set starts_at = $2, ends_at = $3 where id = $1", [
            id,
            T("16:15"),
            T("16:45"),
          ]),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      await inA((c) =>
        c.query("update appointments set starts_at = $2, ends_at = $3 where id = $1", [
          id,
          T("17:00"),
          T("17:30"),
        ]),
      );
      // Updating notes does not touch occupancy.
      await inA((c) => c.query("update appointments set notes = 'bring x-ray' where id = $1", [id]));
    });

    it("idempotency key prevents a duplicate booking from a retried request", async () => {
      await inA((c) => book(c, { start: T("18:00"), end: T("18:30"), key: "req-1" }));
      await expect(
        inA((c) => book(c, { start: T("18:00"), end: T("18:30"), key: "req-1" })),
      ).rejects.toMatchObject({
        code: "23505",
      });
    });

    it("20 simultaneous bookings for one slot produce exactly one appointment (×50 rounds)", async () => {
      for (let round = 0; round < 50; round++) {
        const day = new Date(Date.UTC(2027, 0, 1 + round)).toISOString().slice(0, 10);
        const attempts = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) =>
            inA((c) =>
              book(c, {
                start: T("10:00", day),
                end: T("10:30", day),
                doctor: i % 2,
                chair: 0,
                patient: i % 2,
              }),
            ),
          ),
        );
        const ok = attempts.filter((r) => r.status === "fulfilled");
        const failed = attempts.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(ok).toHaveLength(1);
        for (const f of failed) expect(f.reason.code).toBe("23P01");
      }
    });
  });

  describe("slot holds", () => {
    const hold = (c: PoolClient, start: string, end: string, expires: string) =>
      c.query(
        `insert into slot_holds (clinic_id, branch_id, doctor_id, chair_id, starts_at, ends_at, expires_at, holder)
         values ($1, $2, $3, $4, $5, $6, $7, 'call:test') returning id`,
        [a.clinicId, a.branchId, a.doctorIds[0], a.chairIds[0], start, end, expires],
      );

    it("an active hold blocks others from booking the slot", async () => {
      await inA((c) =>
        hold(
          c,
          T("10:00", "2026-12-01"),
          T("10:30", "2026-12-01"),
          new Date(Date.now() + 180_000).toISOString(),
        ),
      );
      await expect(
        inA((c) => book(c, { start: T("10:00", "2026-12-01"), end: T("10:30", "2026-12-01") })),
      ).rejects.toMatchObject({ code: "23P01" });
    });

    it("an expired hold never blocks a booking, even before the sweeper runs", async () => {
      await inA((c) =>
        hold(
          c,
          T("11:00", "2026-12-01"),
          T("11:30", "2026-12-01"),
          new Date(Date.now() + 1500).toISOString(),
        ),
      );
      await expect(
        inA((c) => book(c, { start: T("11:00", "2026-12-01"), end: T("11:30", "2026-12-01") })),
      ).rejects.toMatchObject({ code: "23P01" });
      await new Promise((r) => setTimeout(r, 1600));
      await inA((c) => book(c, { start: T("11:00", "2026-12-01"), end: T("11:30", "2026-12-01") }));
    });

    it("refuses a hold that is already expired", async () => {
      await expect(
        inA((c) =>
          hold(
            c,
            T("13:00", "2026-12-01"),
            T("13:30", "2026-12-01"),
            new Date(Date.now() - 1000).toISOString(),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("converting a hold into an appointment is atomic", async () => {
      const holdId = await inA(
        async (c) =>
          (
            await hold(
              c,
              T("12:00", "2026-12-01"),
              T("12:30", "2026-12-01"),
              new Date(Date.now() + 180_000).toISOString(),
            )
          ).rows[0].id,
      );
      await inA(async (c) => {
        await c.query("delete from slot_holds where id = $1", [holdId]);
        await book(c, { start: T("12:00", "2026-12-01"), end: T("12:30", "2026-12-01") });
      });
      const { rows } = await db.pool.query(
        "select count(*)::int as n from resource_occupancy where source_id = $1",
        [holdId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe("emergency reserves", () => {
    const range = `[${T("19:00", "2026-12-02")}, ${T("19:30", "2026-12-02")})`;

    it("block ordinary booking of the chair until staff release them", async () => {
      const { rows } = await db.pool.query(
        "insert into emergency_slots (clinic_id, branch_id, chair_id, weekday, start_time, duration_min) values ($1,$2,$3,3,'19:00',30) returning id",
        [a.clinicId, a.branchId, a.chairIds[1]],
      );
      const made = await db.pool.query(
        "select app.materialize_emergency_reserve($1,$2,$3,$4::tstzrange) as ok",
        [a.clinicId, rows[0].id, a.chairIds[1], range],
      );
      expect(made.rows[0].ok).toBe(true);
      await expect(
        inA((c) => book(c, { start: T("19:00", "2026-12-02"), end: T("19:30", "2026-12-02"), chair: 1 })),
      ).rejects.toMatchObject({ code: "23P01" });

      await expect(
        withClinic(db.pool, { ...ctxA, role: "agent" }, (c) =>
          c.query("select app.release_emergency_reserve($1, $2::tstzrange)", [a.chairIds[1], range]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      await inA(async (c) => {
        await c.query("select app.release_emergency_reserve($1, $2::tstzrange)", [a.chairIds[1], range]);
        await book(c, { start: T("19:00", "2026-12-02"), end: T("19:30", "2026-12-02"), chair: 1 });
      });
    });
  });

  describe("tenant isolation (every tenant table)", () => {
    const tables = [
      "clinics",
      "branches",
      "clinic_memberships",
      "doctors",
      "doctor_visiting_schedules",
      "chairs",
      "procedure_types",
      "working_hours",
      "breaks",
      "holidays",
      "leaves",
      "emergency_slots",
      "patients",
      "patient_family_links",
      "appointments",
      "slot_holds",
      "resource_occupancy",
      "audit_log",
      "clinic_channels",
      "conversations",
      "messages",
      "outbox",
      "message_templates",
      "consents",
      "opt_outs",
      "tasks",
      "calls",
      "call_turns",
      "treatment_templates",
      "treatment_plans",
      "treatment_steps",
      "estimates",
      "followup_ladders",
      "followup_runs",
      "followup_actions",
      "campaigns",
      "campaign_recipients",
      "doc_sequences",
      "invoices",
      "payment_links",
      "patient_ledger",
      "invoice_charges",
      "receipts",
      "licenses",
      "wallets",
      "usage_ledger",
      "wallet_credits",
      "mandates",
      "recharges",
      "sentio_invoices",
      "leads",
      "lead_activities",
    ];

    beforeAll(async () => {
      // Make sure clinic B has at least one row in every table.
      const q = (sql: string, p: unknown[]) => db.pool.query(sql, p);
      await q(
        "insert into clinic_memberships (clinic_id, invited_phone, display_name, role) values ($1,'+919800000001','B owner','owner')",
        [b.clinicId],
      );
      await q(
        "insert into doctor_visiting_schedules (clinic_id, doctor_id, branch_id, weekday, start_time, end_time) values ($1,$2,$3,2,'11:00','17:00')",
        [b.clinicId, b.doctorIds[1], b.branchId],
      );
      await q(
        "insert into working_hours (clinic_id, branch_id, weekday, start_time, end_time) values ($1,$2,1,'10:00','20:00')",
        [b.clinicId, b.branchId],
      );
      await q(
        "insert into breaks (clinic_id, branch_id, weekday, start_time, end_time) values ($1,$2,1,'14:00','15:00')",
        [b.clinicId, b.branchId],
      );
      await q("insert into holidays (clinic_id, date, name) values ($1,'2026-10-20','Diwali')", [b.clinicId]);
      await q(
        "insert into leaves (clinic_id, doctor_id, starts_at, ends_at) values ($1,$2,now(),now()+interval '1 day')",
        [b.clinicId, b.doctorIds[0]],
      );
      await q(
        "insert into emergency_slots (clinic_id, branch_id, chair_id, weekday, start_time, duration_min) values ($1,$2,$3,1,'18:00',30)",
        [b.clinicId, b.branchId, b.chairIds[0]],
      );
      await q(
        "insert into patient_family_links (clinic_id, patient_id, related_patient_id, relationship) values ($1,$2,$3,'mother')",
        [b.clinicId, b.patientIds[0], b.patientIds[1]],
      );
      await q(
        "insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at) values ($1,$2,$3,$4,$5,$6,$7)",
        [b.clinicId, b.branchId, b.patientIds[0], b.doctorIds[0], b.chairIds[0], T("09:00"), T("09:30")],
      );
      await q(
        "insert into slot_holds (clinic_id, branch_id, doctor_id, chair_id, starts_at, ends_at, expires_at, holder) values ($1,$2,$3,$4,$5,$6,now()+interval '1 hour','x')",
        [b.clinicId, b.branchId, b.doctorIds[1], b.chairIds[1], T("12:00"), T("12:30")],
      );
      await withClinic(db.pool, { clinicId: b.clinicId, actor: "system" }, (c) =>
        c.query("update patients set notes = 'x' where clinic_id = $1", [b.clinicId]),
      );
      await q(
        "insert into clinic_channels (clinic_id, kind, external_id, display_phone) values ($1,'whatsapp','pnid-b','+916512000000')",
        [b.clinicId],
      );
      const conv = await q(
        "insert into conversations (clinic_id, channel, phone) values ($1,'whatsapp','+919876543210') returning id",
        [b.clinicId],
      );
      await q(
        "insert into messages (clinic_id, conversation_id, direction, author, kind, body, status) values ($1,$2,'in','patient','text','hi','received')",
        [b.clinicId, conv.rows[0].id],
      );
      await q(
        "insert into outbox (clinic_id, channel, to_phone, category, purpose, payload, dedupe_key) values ($1,'whatsapp','+919876543210','service','test','{}','k1')",
        [b.clinicId],
      );
      await q(
        "insert into message_templates (clinic_id, purpose, name, language, category, body) values ($1,'x','x','en','utility','x')",
        [b.clinicId],
      );
      await q(
        "insert into consents (clinic_id, phone, purpose, channel, granted, notice_version, captured_via) values ($1,'+919876543210','reminders','whatsapp',true,'v1','test')",
        [b.clinicId],
      );
      await q(
        "insert into opt_outs (clinic_id, phone, channel, category, source) values ($1,'+919876543210','all','promotional','test')",
        [b.clinicId],
      );
      await q(
        "insert into tasks (clinic_id, kind, title, created_by) values ($1,'callback','Call back','bot')",
        [b.clinicId],
      );
      const call = await q(
        "insert into calls (clinic_id, provider, provider_call_id, from_phone) values ($1,'fake','call-b','+919876543210') returning id",
        [b.clinicId],
      );
      await q(
        "insert into call_turns (clinic_id, call_id, seq, speaker, text) values ($1,$2,1,'caller','hello')",
        [b.clinicId, call.rows[0].id],
      );
      const proc = (await q("select id from procedure_types where clinic_id = $1 limit 1", [b.clinicId]))
        .rows[0].id;
      const tpl = await q(
        "insert into treatment_templates (clinic_id, code, name, steps) values ($1, 'x', 'X', '[{\"procedure_code\": \"x\"}]') returning id",
        [b.clinicId],
      );
      const plan = await q(
        "insert into treatment_plans (clinic_id, patient_id, template_id, title) values ($1, $2, $3, 'Plan') returning id",
        [b.clinicId, b.patientIds[0], tpl.rows[0].id],
      );
      await q(
        "insert into treatment_steps (clinic_id, plan_id, seq, procedure_type_id) values ($1, $2, 1, $3)",
        [b.clinicId, plan.rows[0].id, proc],
      );
      await q(
        "insert into estimates (clinic_id, patient_id, items, total_paise, valid_until) values ($1, $2, '[{\"label\": \"x\"}]', 100, '2030-01-01')",
        [b.clinicId, b.patientIds[0]],
      );
      await q("insert into followup_ladders (clinic_id, kind, steps) values ($1, 'recall', '[{}]')", [
        b.clinicId,
      ]);
      const run = await q(
        "insert into followup_runs (clinic_id, kind, subject_type, subject_id, patient_id, next_at) values ($1, 'recall', 'appointment', gen_random_uuid(), $2, now()) returning id",
        [b.clinicId, b.patientIds[0]],
      );
      await q(
        "insert into followup_actions (clinic_id, run_id, step, action, result) values ($1, $2, 0, 'whatsapp', 'queued')",
        [b.clinicId, run.rows[0].id],
      );
      const campaign = await q("insert into campaigns (clinic_id, name) values ($1, 'C') returning id", [
        b.clinicId,
      ]);
      await q(
        "insert into campaign_recipients (clinic_id, campaign_id, patient_id, phone) values ($1, $2, $3, '+919876543210')",
        [b.clinicId, campaign.rows[0].id, b.patientIds[0]],
      );
      await q("insert into doc_sequences (clinic_id, kind, fy) values ($1, 'receipt', '2026-27')", [
        b.clinicId,
      ]);
      const inv = await q(
        "insert into invoices (clinic_id, number, fy, patient_id, doc_type, lines, taxable_paise, gst_paise, total_paise) values ($1, 'INV-1', '2026-27', $2, 'bill_of_supply', '[]', 100, 0, 100) returning id",
        [b.clinicId, b.patientIds[0]],
      );
      await q(
        "insert into payment_links (clinic_id, patient_id, purpose, amount_paise, provider, provider_link_id, url) values ($1, $2, 'dues', 100, 'fake', 'pl-b', 'https://x')",
        [b.clinicId, b.patientIds[0]],
      );
      const charge = await q(
        "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description) values ($1, $2, 'charge', 100, 'x') returning id",
        [b.clinicId, b.patientIds[0]],
      );
      await q("insert into invoice_charges (clinic_id, invoice_id, ledger_id) values ($1, $2, $3)", [
        b.clinicId,
        inv.rows[0].id,
        charge.rows[0].id,
      ]);
      const pay = await q(
        "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, method, description) values ($1, $2, 'payment', 100, 'cash', 'x') returning id",
        [b.clinicId, b.patientIds[0]],
      );
      await q(
        "insert into receipts (clinic_id, number, fy, patient_id, ledger_id, amount_paise, method) values ($1, 'R-1', '2026-27', $2, $3, 100, 'cash')",
        [b.clinicId, b.patientIds[0], pay.rows[0].id],
      );
      await q("insert into licenses (clinic_id, sku, price_paise) values ($1, 'standard', 100)", [
        b.clinicId,
      ]);
      await q(
        "insert into usage_ledger (clinic_id, kind, quantity, provider_cost_paise, margin_paise, total_paise, ref_type, ref) values ($1, 'sms_segment', 1, 20, 10, 30, 'sms', 'b1')",
        [b.clinicId],
      );
      await q("insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'opening', 1000)", [
        b.clinicId,
      ]);
      const m = await q(
        "insert into mandates (clinic_id, provider, provider_mandate_id, payer_phone, max_amount_paise, status) values ($1, 'fake', 'm-b', '+919800000001', 1500000, 'active') returning id",
        [b.clinicId],
      );
      await q(
        "insert into recharges (clinic_id, via, mandate_id, amount_paise, pre_debit_notified_at, debit_after) values ($1, 'mandate', $2, 100, now(), now() + interval '25 hours')",
        [b.clinicId, m.rows[0].id],
      );
      await q(
        "insert into sentio_invoices (clinic_id, number, fy, kind, lines, taxable_paise, total_paise, buyer) values ($1, 'S-1', '2026-27', 'recharge', '[]', 100, 118, '{}')",
        [b.clinicId],
      );
      const lead = await q(
        "insert into leads (clinic_id, source, phone, name) values ($1, 'meta_form', '+919876500001', 'Lead B') returning id",
        [b.clinicId],
      );
      await q("insert into lead_activities (clinic_id, lead_id, kind) values ($1, $2, 'created')", [
        b.clinicId,
        lead.rows[0].id,
      ]);
    });

    it.each(tables)("clinic A cannot read clinic B's %s", async (table) => {
      const bCount = (
        await db.pool.query(
          `select count(*)::int as n from ${table} where ${table === "clinics" ? "id" : "clinic_id"} = $1`,
          [b.clinicId],
        )
      ).rows[0].n;
      expect(bCount, `fixture must have B rows in ${table}`).toBeGreaterThan(0);
      const seen = await inA(
        async (c) =>
          (
            await c.query(
              `select count(*)::int as n from ${table} where ${table === "clinics" ? "id" : "clinic_id"} = $1`,
              [b.clinicId],
            )
          ).rows[0].n,
      );
      expect(seen).toBe(0);
    });

    it("clinic A cannot write rows into clinic B or modify B's rows", async () => {
      await expect(
        inA((c) => c.query("insert into patients (clinic_id, name) values ($1, 'spy')", [b.clinicId])),
      ).rejects.toThrow(/row-level security/);
      const updated = await inA(
        async (c) =>
          (await c.query("update patients set name = 'hacked' where clinic_id = $1", [b.clinicId])).rowCount,
      );
      expect(updated).toBe(0);
      const deleted = await inA(
        async (c) => (await c.query("delete from appointments where clinic_id = $1", [b.clinicId])).rowCount,
      );
      expect(deleted).toBe(0);
    });

    it("clinic A cannot book its patient with clinic B's doctor (cross-tenant reference)", async () => {
      await expect(
        inA((c) =>
          c.query(
            "insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at) values ($1,$2,$3,$4,$5,$6,$7)",
            [a.clinicId, a.branchId, a.patientIds[0], b.doctorIds[0], a.chairIds[0], T("20:00"), T("20:30")],
          ),
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("without a clinic context nothing is visible", async () => {
      const n = await withAppRole(
        db.pool,
        async (c) => (await c.query("select count(*)::int as n from patients")).rows[0].n,
      );
      expect(n).toBe(0);
    });

    it("the app cannot write occupancy or audit rows directly", async () => {
      await expect(
        inA((c) =>
          c.query(
            "insert into resource_occupancy (clinic_id, resource_kind, resource_id, occupied, source_kind, source_id) values ($1,'chair',$2,'[2027-01-01,2027-01-02)','hold',gen_random_uuid())",
            [a.clinicId, a.chairIds[0]],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        inA((c) =>
          c.query("insert into audit_log (clinic_id, actor, action, entity) values ($1,'x','insert','x')", [
            a.clinicId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("audit log", () => {
    it("records who changed what, with before and after", async () => {
      const { rows } = await db.pool.query(
        "insert into patients (clinic_id, name, phone) values ($1, 'Audit Test', '+919811112222') returning id",
        [a.clinicId],
      );
      await withClinic(
        db.pool,
        { clinicId: a.clinicId, actor: "user:abc", userId: "00000000-0000-4000-8000-000000000001" },
        (c) => c.query("update patients set name = 'Audit Test Ji' where id = $1", [rows[0].id]),
      );
      const log = await db.pool.query(
        "select actor, user_id, action, before->>'name' as b, after->>'name' as a from audit_log where entity_id = $1 order by id",
        [rows[0].id],
      );
      expect(log.rows.at(-1)).toEqual({
        actor: "user:abc",
        user_id: "00000000-0000-4000-8000-000000000001",
        action: "update",
        b: "Audit Test",
        a: "Audit Test Ji",
      });
      await expect(db.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
    });
  });

  describe("login and memberships", () => {
    it("claims an invitation by phone on first login and lists memberships", async () => {
      await db.pool.query(
        "insert into clinic_memberships (clinic_id, invited_phone, display_name, role) values ($1,'+919700000001','Priya','receptionist')",
        [a.clinicId],
      );
      const userId = "00000000-0000-4000-8000-0000000000aa";
      const list = await withAppRole(
        db.pool,
        async (c) => {
          await c.query("select app.ensure_user($1, null, null)", ["+919700000001"]);
          return (await c.query("select clinic_id, role from app.my_memberships()")).rows;
        },
        { userId },
      );
      expect(list).toEqual([{ clinic_id: a.clinicId, role: "receptionist" }]);
    });
  });

  describe("money (Phase 5)", () => {
    const inA2 = <T>(fn: (c: import("pg").PoolClient) => Promise<T>) =>
      withClinic(db.pool, { clinicId: a.clinicId, actor: "system", role: "system" }, fn);

    it("the patient ledger and usage ledger are append-only", async () => {
      const row = await inA2(
        async (c) =>
          (
            await c.query(
              "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description) values ($1, $2, 'charge', 50000, 'RCT') returning id",
              [a.clinicId, a.patientIds[0]],
            )
          ).rows[0].id,
      );
      await expect(
        inA2((c) => c.query("update patient_ledger set amount_paise = 1 where id = $1", [row])),
      ).rejects.toThrow(/append-only/);
      // No delete right at all for the app, and the trigger stops the owner role too.
      await expect(inA2((c) => c.query("delete from patient_ledger where id = $1", [row]))).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.pool.query("delete from patient_ledger where id = $1", [row])).rejects.toThrow(
        /append-only/,
      );
      await inA2((c) =>
        c.query(
          "insert into usage_ledger (clinic_id, kind, quantity, provider_cost_paise, margin_paise, total_paise, ref_type, ref) values ($1, 'sms_segment', 1, 20, 10, 30, 'sms', 'a-append')",
          [a.clinicId],
        ),
      );
      await expect(db.pool.query("delete from usage_ledger where ref = 'a-append'")).rejects.toThrow(
        /append-only/,
      );
    });

    it("a payment needs a method, a charge must not have one, and amounts are positive", async () => {
      const bad = [
        "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, description) values ($1, $2, 'payment', 100, 'x')",
        "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, method, description) values ($1, $2, 'charge', 100, 'cash', 'x')",
        "insert into patient_ledger (clinic_id, patient_id, kind, amount_paise, method, description) values ($1, $2, 'payment', -5, 'cash', 'x')",
      ];
      for (const sql of bad)
        await expect(inA2((c) => c.query(sql, [a.clinicId, a.patientIds[0]]))).rejects.toThrow(/check/);
    });

    it("receipt numbers run without gaps, per clinic and financial year, even when requested at once", async () => {
      const numbers = await Promise.all(
        Array.from({ length: 20 }, () =>
          inA2(
            async (c) => (await c.query("select app.next_doc_number('receipt', '2030-31') as n")).rows[0].n,
          ),
        ),
      );
      expect([...numbers].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const other = await withClinic(
        db.pool,
        { clinicId: b.clinicId, actor: "system" },
        async (c) => (await c.query("select app.next_doc_number('receipt', '2030-31') as n")).rows[0].n,
      );
      expect(other).toBe(1);
    });

    it("the wallet balance and state follow every usage and credit row", async () => {
      const wallet = () =>
        db.pool
          .query("select balance_paise, state from wallets where clinic_id = $1", [a.clinicId])
          .then((r) => r.rows[0]);
      const start = (await wallet()).balance_paise as number;
      await db.pool.query(
        "insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'adjustment', $2)",
        [a.clinicId, 100000 - start],
      );
      expect(await wallet()).toEqual({ balance_paise: 100000, state: "active" });
      const use = (ref: string, paise: number) =>
        inA2((c) =>
          c.query(
            "insert into usage_ledger (clinic_id, kind, quantity, provider_cost_paise, margin_paise, total_paise, ref_type, ref) values ($1, 'telephony_min', 1, 0, 0, $2, 'call', $3)",
            [a.clinicId, paise, ref],
          ),
        );
      await use("w1", 60000);
      expect(await wallet()).toEqual({ balance_paise: 40000, state: "low" });
      await use("w2", 50000);
      expect(await wallet()).toEqual({ balance_paise: -10000, state: "grace" });
      await use("w3", 10000);
      expect(await wallet()).toEqual({ balance_paise: -20000, state: "suspended" });
      // The same usage twice is charged once.
      await expect(use("w3", 10000)).rejects.toThrow(/duplicate key/);
      const truth = (await db.pool.query("select app.wallet_ledger_balance($1) as b", [a.clinicId])).rows[0]
        .b;
      expect(Number(truth)).toBe(-20000);
    });

    it("a clinic can change its wallet settings but never its balance", async () => {
      await inA2((c) =>
        c.query("update wallets set threshold_paise = 30000 where clinic_id = $1", [a.clinicId]),
      );
      await expect(
        inA2((c) =>
          c.query("update wallets set balance_paise = 99999999 where clinic_id = $1", [a.clinicId]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        inA2((c) =>
          c.query("insert into wallet_credits (clinic_id, kind, amount_paise) values ($1, 'topup', 100)", [
            a.clinicId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("an auto-debit cannot be scheduled less than 24 hours after its pre-debit notice", async () => {
      const m = await db.pool.query(
        "insert into mandates (clinic_id, provider, provider_mandate_id, payer_phone, max_amount_paise, status) values ($1, 'fake', 'm-a', '+919800000002', 1500000, 'active') returning id",
        [a.clinicId],
      );
      await expect(
        db.pool.query(
          "insert into recharges (clinic_id, via, mandate_id, amount_paise, pre_debit_notified_at, debit_after) values ($1, 'mandate', $2, 100, now(), now() + interval '2 hours')",
          [a.clinicId, m.rows[0].id],
        ),
      ).rejects.toThrow(/check/);
    });
  });
});

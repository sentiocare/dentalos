import { voiceServiceHealthy, voiceSettings } from "@dentalos/agent";
import type { StorageProvider } from "@dentalos/adapters";
import type { Pool } from "@dentalos/db";
import { normalizePhone } from "@dentalos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

/** Phone calls for the dashboard: list, transcript and recording, test-call results, voice settings. */
export function callRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; pool: Pool; storage: StorageProvider },
) {
  app.get("/v1/calls", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const q = parse(
        z.object({
          filter: z.enum(["all", "assistant", "forwarded", "emergency", "test"]).default("all"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      const { rows } = await c.query(
        `select k.id, k.started_at, k.from_phone, k.route, k.status, k.outcome, k.intents, k.language, k.duration_sec,
                k.summary, k.is_test, k.test_result, k.transfer_kind, k.appointment_id, k.latency,
                p.id as patient_id, p.name as patient_name
         from calls k left join patients p on p.id = k.patient_id
         where $1 = 'all' or ($1 = 'assistant' and k.route = 'assistant') or ($1 = 'forwarded' and k.route <> 'assistant')
               or ($1 = 'emergency' and k.outcome = 'emergency') or ($1 = 'test' and k.is_test)
         order by k.started_at desc limit $2`,
        [q.filter, q.limit],
      );
      return rows;
    }),
  );

  app.get("/v1/calls/test-summary", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const { rows } = await c.query(
        `select count(*) filter (where test_result = 'pass')::int as passed,
                count(*) filter (where test_result = 'fail')::int as failed
         from calls where is_test`,
      );
      return { ...rows[0], target: 50 };
    }),
  );

  app.get("/v1/calls/:id", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const { id } = parse(idParams, request.params);
      const call = (
        await c.query(
          `select k.id, k.started_at, k.answered_at, k.ended_at, k.from_phone, k.route, k.status, k.outcome, k.intents,
                  k.language, k.duration_sec, k.summary, k.is_test, k.test_result, k.test_notes, k.transfer_kind,
                  k.transfer_numbers, k.transfer_status, k.appointment_id, k.usage, k.latency, k.recording_key,
                  p.id as patient_id, p.name as patient_name
           from calls k left join patients p on p.id = k.patient_id where k.id = $1`,
          [id],
        )
      ).rows[0];
      if (!call) throw new HttpError(404, "not_found", "Call not found");
      const turns = (
        await c.query(
          "select seq, speaker, text, latency_ms, flags, at from call_turns where call_id = $1 order by seq",
          [id],
        )
      ).rows;
      const tasks = (
        await c.query(
          "select id, kind, priority, title, status from tasks where call_id = $1 order by created_at",
          [id],
        )
      ).rows;
      const { recording_key: key, ...rest } = call;
      return {
        call: rest,
        turns,
        tasks,
        recordingUrl: key ? await deps.storage.signedUrl(key, 15 * 60) : null,
      };
    }),
  );

  // Acceptance testing: the tester marks each real test call as pass or fail (PLAN Phase 3).
  app.post("/v1/calls/:id/test", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c, staff) => {
      const { id } = parse(idParams, request.params);
      const b = parse(
        z.object({ result: z.enum(["pass", "fail"]), notes: z.string().trim().max(2000).optional() }),
        request.body,
      );
      const { rowCount } = await c.query(
        "update calls set is_test = true, test_result = $2, test_notes = $3, tested_by = $4, tested_at = now() where id = $1",
        [id, b.result, b.notes ?? null, staff.user.userId],
      );
      if (!rowCount) throw new HttpError(404, "not_found", "Call not found");
      return { ok: true };
    }),
  );

  app.get("/v1/voice", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const clinic = (await c.query("select phone, settings from clinics where id = app.current_clinic_id()"))
        .rows[0];
      const channel = (
        await c.query("select external_id from clinic_channels where kind = 'voice' and active limit 1")
      ).rows[0];
      return {
        ...voiceSettings(clinic.settings),
        clinicPhone: clinic.phone,
        virtualNumber: channel?.external_id ?? null,
        serviceHealthy: await voiceServiceHealthy(deps.pool),
      };
    }),
  );

  const phone = z
    .string()
    .trim()
    .transform((v, ctx) => {
      const p = normalizePhone(v);
      if (!p) ctx.addIssue({ code: "custom", message: "Not a valid phone number" });
      return p ?? "";
    });

  app.put("/v1/voice", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const b = parse(
        z.object({
          enabled: z.boolean(),
          answerMode: z.enum(["all", "after_hours"]),
          staffPhones: z.array(phone).max(5),
          virtualNumber: phone.nullable().optional(),
          outboundCalls: z.boolean().optional(),
          leadCalls: z.boolean().optional(),
          outboundFlowId: z
            .string()
            .trim()
            .max(40)
            .regex(/^[0-9]*$/, "The flow ID is a number")
            .nullable()
            .optional(),
        }),
        request.body,
      );
      // Keep settings this request does not mention (e.g. outbound hours).
      const current =
        (await c.query("select settings->'voice' as v from clinics where id = app.current_clinic_id()"))
          .rows[0].v ?? {};
      const next = { ...current, enabled: b.enabled, answerMode: b.answerMode, staffPhones: b.staffPhones };
      if (b.outboundCalls !== undefined) next.outboundCalls = b.outboundCalls;
      if (b.leadCalls !== undefined) next.leadCalls = b.leadCalls;
      if (b.outboundFlowId !== undefined) next.outboundFlowId = b.outboundFlowId || null;
      await c.query(
        "update clinics set settings = jsonb_set(settings, '{voice}', $1::jsonb) where id = app.current_clinic_id()",
        [JSON.stringify(next)],
      );
      if (b.virtualNumber) {
        const taken = (await c.query("select app.clinic_for_channel('voice', $1) as id", [b.virtualNumber]))
          .rows[0].id;
        if (taken && taken !== (await c.query("select app.current_clinic_id() as id")).rows[0].id)
          throw new HttpError(409, "number_in_use", "This number is connected to another clinic");
        await c.query(
          "update clinic_channels set active = false where kind = 'voice' and external_id <> $1",
          [b.virtualNumber],
        );
        await c.query(
          `insert into clinic_channels (clinic_id, kind, external_id, display_phone)
           values (app.current_clinic_id(), 'voice', $1, $1)
           on conflict (kind, external_id) do update set active = true`,
          [b.virtualNumber],
        );
      }
      return { ok: true };
    }),
  );
}

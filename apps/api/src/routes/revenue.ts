import type { StorageProvider } from "@dentalos/adapters";
import {
  approveCampaign,
  campaignAudience,
  cancelCampaign,
  checkPromotionalText,
  createCampaign,
  createEstimate,
  createTreatmentPlan,
  decideEstimate,
  DEFAULT_LADDERS,
  estimateFromPlan,
  findSlots,
  getLadders,
  incompleteTreatments,
  listCampaigns,
  listFollowups,
  nextSitting,
  patientEstimates,
  patientPlans,
  recordMarketingConsent,
  runCampaign,
  saveLadder,
  scheduleSend,
  sendEstimate,
  setPlanStatus,
  stopFollowup,
  submitCampaign,
  updateStep,
  type FollowupKind,
  type JobQueue,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

const uuid = z.string().uuid();
const paise = z.number().int().min(0).max(10_000_000_00);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kinds = Object.keys(DEFAULT_LADDERS) as [FollowupKind, ...FollowupKind[]];

/**
 * The revenue engine for staff (Build Prompt §5.4, PLAN Phase 4): treatment plans, estimates, the
 * incomplete-treatments list, follow-ups and their ladders, reactivation campaigns.
 */
export function revenueRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; storage: StorageProvider; jobs: JobQueue },
) {
  // ------------------------------------------------------------------ treatment plans

  app.get("/v1/treatment-templates", (request) =>
    deps.staff.inClinic(
      request,
      "patients.read",
      async (c) =>
        (
          await c.query(
            "select id, code, name, name_hi, steps, active from treatment_templates where active order by sort_order, name",
          )
        ).rows,
    ),
  );

  app.get("/v1/patients/:id/plans", (request) =>
    deps.staff.inClinic(request, "patients.read", (c) => patientPlans(c, parse(idParams, request.params).id)),
  );

  app.post("/v1/patients/:id/plans", (request) =>
    deps.staff.inClinic(request, "patients.write", (c, staff) => {
      const b = parse(
        z
          .object({
            templateId: uuid.optional(),
            steps: z
              .array(
                z.object({
                  procedureTypeId: uuid,
                  gapMinDays: z.number().int().min(0).max(365).optional(),
                  gapMaxDays: z.number().int().min(0).max(365).optional(),
                  valuePaise: paise.optional(),
                  tooth: z.string().max(10).optional(),
                }),
              )
              .max(40)
              .optional(),
            title: z.string().trim().min(1).max(120).optional(),
            teeth: z
              .array(z.string().regex(/^[1-8][1-8]$/))
              .max(32)
              .optional(),
            doctorId: uuid.nullish(),
            startDate: date.optional(),
            values: z.array(paise).max(40).optional(),
            status: z.enum(["proposed", "accepted"]).default("proposed"),
            notes: z.string().max(2000).optional(),
          })
          .refine((v) => v.templateId || v.steps?.length, "Choose a template or add sittings"),
        request.body,
      );
      return createTreatmentPlan(c, {
        ...b,
        patientId: parse(idParams, request.params).id,
        createdBy: staff.user.userId,
      });
    }),
  );

  app.post("/v1/plans/:id/accept", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      await setPlanStatus(c, parse(idParams, request.params).id, "accept");
      return { ok: true };
    }),
  );

  app.post("/v1/plans/:id/abandon", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      const { reason } = parse(
        z.object({ reason: z.string().trim().max(500).optional() }),
        request.body ?? {},
      );
      await setPlanStatus(c, parse(idParams, request.params).id, "abandon", reason);
      return { ok: true };
    }),
  );

  app.patch("/v1/plan-steps/:id", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      const b = parse(z.object({ valuePaise: paise.optional(), skip: z.boolean().optional() }), request.body);
      await updateStep(c, parse(idParams, request.params).id, b);
      return { ok: true };
    }),
  );

  /** The next sitting and free times inside its window, for "book next sitting" after a visit. */
  app.get("/v1/plans/:id/next", (request) =>
    deps.staff.inClinic(request, "appointments.read", async (c) => {
      const next = await nextSitting(c, parse(idParams, request.params).id);
      if (!next) return { next: null, slots: [] };
      const slots = await findSlots(c, {
        procedureId: next.procedure_type_id,
        fromDate: next.expected_from ?? undefined,
        toDate: next.expected_to ?? undefined,
        doctorId: next.doctor_id ?? undefined,
      });
      return {
        next,
        slots: slots
          .slice(0, 12)
          .map((s) => ({ start: s.start, end: s.end, doctorId: s.doctorId, chairId: s.chairId })),
      };
    }),
  );

  app.get("/v1/incomplete-treatments", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c, staff) => {
      const result = await incompleteTreatments(c);
      // Rupee values follow the "see revenue" permission (the owner can switch it off for reception).
      if (staff.permissions.has("reports.revenue")) return result;
      return {
        rows: result.rows.map((r) => ({ ...r, remainingPaise: null })),
        totals: {
          plans: result.totals.plans,
          overduePlans: result.totals.overduePlans,
          remainingPaise: null,
          overduePaise: null,
        },
      };
    }),
  );

  // ------------------------------------------------------------------ estimates

  app.get("/v1/patients/:id/estimates", (request) =>
    deps.staff.inClinic(request, "patients.read", (c) =>
      patientEstimates(c, parse(idParams, request.params).id),
    ),
  );

  app.post("/v1/patients/:id/estimates", (request) =>
    deps.staff.inClinic(request, "patients.write", (c, staff) => {
      const b = parse(
        z.object({
          items: z
            .array(
              z.object({
                label: z.string().trim().min(1).max(120),
                procedureTypeId: uuid.nullish(),
                tooth: z.string().max(10).nullish(),
                qty: z.number().int().min(1).max(50),
                amountPaise: paise,
              }),
            )
            .min(1)
            .max(50),
          emiNote: z.string().trim().max(200).nullish(),
          validDays: z.number().int().min(1).max(180).optional(),
          planId: uuid.nullish(),
        }),
        request.body,
      );
      return createEstimate(c, {
        ...b,
        patientId: parse(idParams, request.params).id,
        createdBy: staff.user.userId,
      });
    }),
  );

  app.post("/v1/plans/:id/estimate", (request) =>
    deps.staff.inClinic(request, "patients.write", (c, staff) =>
      estimateFromPlan(c, parse(idParams, request.params).id, { createdBy: staff.user.userId }),
    ),
  );

  app.post("/v1/estimates/:id/send", (request) =>
    deps.staff
      .inClinic(request, "patients.write", async (c, staff) => ({
        staff,
        ...(await sendEstimate(c, parse(idParams, request.params).id, { storage: deps.storage })),
      }))
      .then(async ({ staff, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ok: true, queued: !!outboxId };
      }),
  );

  app.post("/v1/estimates/:id/decision", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      const { decision } = parse(z.object({ decision: z.enum(["accepted", "declined"]) }), request.body);
      await decideEstimate(c, parse(idParams, request.params).id, decision);
      return { ok: true };
    }),
  );

  app.get("/v1/estimates/:id/pdf", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const e = (
        await c.query("select document_key from estimates where id = $1", [
          parse(idParams, request.params).id,
        ])
      ).rows[0];
      if (!e?.document_key) throw new HttpError(404, "not_found", "The estimate has not been sent yet");
      return { url: await deps.storage.signedUrl(e.document_key, 15 * 60) };
    }),
  );

  // ------------------------------------------------------------------ follow-ups

  app.get("/v1/followups", (request) =>
    deps.staff.inClinic(request, "appointments.read", (c) => {
      const q = parse(
        z.object({
          status: z.enum(["active", "finished"]).optional(),
          kind: z.enum(kinds).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        request.query,
      );
      return listFollowups(c, q);
    }),
  );

  app.post("/v1/followups/:id/stop", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c, staff) => {
      const { reason } = parse(
        z.object({ reason: z.string().trim().max(300).optional() }),
        request.body ?? {},
      );
      const ok = await stopFollowup(
        c,
        parse(idParams, request.params).id,
        reason ?? `Stopped by ${staff.displayName}`,
      );
      if (!ok) throw new HttpError(409, "not_active", "This follow-up has already finished");
      return { ok: true };
    }),
  );

  app.get("/v1/followup-ladders", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => getLadders(c)),
  );

  app.put("/v1/followup-ladders/:kind", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const { kind } = parse(z.object({ kind: z.enum(kinds) }), request.params);
      const b = parse(
        z.object({
          active: z.boolean(),
          steps: z
            .array(
              z.object({
                afterHours: z
                  .number()
                  .int()
                  .min(0)
                  .max(24 * 60),
                atLocalTime: z
                  .string()
                  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
                  .optional(),
                action: z.enum(["whatsapp", "ai_call", "staff_task"]),
                template: z.string().optional(),
              }),
            )
            .min(1)
            .max(10),
        }),
        request.body,
      );
      // WhatsApp steps keep the template that belongs to this kind of follow-up.
      const defaultTemplate = DEFAULT_LADDERS[kind].find((s) => s.template)?.template;
      const steps = b.steps.map((s) => ({
        ...s,
        template: s.action === "whatsapp" ? (defaultTemplate ?? s.template) : undefined,
      })) as Parameters<typeof saveLadder>[2];
      if (kind !== "unconfirmed" && steps.some((s) => s.action === "ai_call"))
        throw new HttpError(400, "invalid", "AI calls are only used to confirm appointments");
      await saveLadder(c, kind, steps, b.active);
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------------ campaigns

  app.get("/v1/campaigns", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => listCampaigns(c)),
  );

  app.get("/v1/campaigns/audience", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const { inactiveMonths } = parse(
        z.object({ inactiveMonths: z.coerce.number().int().min(3).max(60).default(12) }),
        request.query,
      );
      const a = await campaignAudience(c, inactiveMonths);
      return { eligible: a.eligible.length, noConsent: a.noConsent, optedOut: a.optedOut };
    }),
  );

  app.post("/v1/campaigns/check-text", (request) =>
    deps.staff.inClinic(request, "settings.manage", async () => {
      const { text } = parse(z.object({ text: z.string().max(500) }), request.body);
      return { problems: checkPromotionalText(text) };
    }),
  );

  app.post("/v1/campaigns", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c, staff) => {
      const b = parse(
        z.object({
          name: z.string().trim().min(1).max(100),
          inactiveMonths: z.number().int().min(3).max(60),
          offerText: z.string().trim().min(1).max(300),
        }),
        request.body,
      );
      return createCampaign(c, { ...b, createdBy: staff.user.userId });
    }),
  );

  const campaignAction = (
    path: string,
    fn: (
      c: Parameters<Parameters<StaffContextService["inClinic"]>[2]>[0],
      id: string,
      userId: string,
    ) => Promise<unknown>,
    ownerOnly = false,
  ) =>
    app.post(`/v1/campaigns/:id/${path}`, (request) =>
      deps.staff.inClinic(request, "settings.manage", async (c, staff) => {
        // Promotions need the owner's own approval (Build Prompt §7.7).
        if (ownerOnly && staff.role !== "owner")
          throw new HttpError(403, "forbidden", "Only the clinic owner can do this");
        const result = await fn(c, parse(idParams, request.params).id, staff.user.userId);
        return result ?? { ok: true };
      }),
    );
  campaignAction("submit", (c, id) => submitCampaign(c, id));
  campaignAction("approve", (c, id, userId) => approveCampaign(c, id, userId), true);
  campaignAction("run", (c, id) => runCampaign(c, id), true);
  campaignAction("cancel", (c, id) => cancelCampaign(c, id));

  // Marketing consent recorded by staff (e.g. the patient said yes at the desk). Append-only.
  app.post("/v1/patients/:id/marketing-consent", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c, staff) => {
      const { granted } = parse(z.object({ granted: z.boolean() }), request.body);
      const p = (
        await c.query("select id, phone from patients where id = $1", [parse(idParams, request.params).id])
      ).rows[0];
      if (!p?.phone) throw new HttpError(400, "invalid", "The patient has no phone number");
      await recordMarketingConsent(c, {
        phone: p.phone,
        patientId: p.id,
        granted,
        via: `staff:${staff.user.userId}`,
      });
      return { ok: true };
    }),
  );
}

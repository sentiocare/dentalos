import {
  connectMetaPage,
  createLead,
  leadDetail,
  leadFunnel,
  leadSettings,
  listLeads,
  qualifyLead,
  recordCallOutcome,
  reopenLead,
  saveLeadAlertPhone,
  type JobQueue,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

const stages = [
  "new",
  "contacted",
  "engaged",
  "qualified",
  "booked",
  "visited",
  "won",
  "lost",
  "unresponsive",
] as const;
const needs = ["pain", "implant", "braces", "rct", "cleaning", "cosmetic", "major", "other"] as const;
const timings = ["now", "week", "month", "exploring"] as const;

/**
 * Leads (Phase 6): the list staff work from (hot and due calls first), a lead's timeline, recording how a
 * call went, adding leads from other sources, the funnel, and connecting the clinic's Facebook Page.
 */
export function leadRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; jobs: JobQueue; channelKey: Buffer | null },
) {
  app.get("/v1/leads", (request) =>
    deps.staff.inClinic(request, "patients.read", (c) => {
      const q = parse(
        z.object({
          stage: z.enum([...stages, "open", "call"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        request.query,
      );
      return listLeads(c, q);
    }),
  );

  app.get("/v1/leads/funnel", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c, staff) => {
      const q = parse(
        z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
        request.query,
      );
      const f = await leadFunnel(c, { from: new Date(q.from), to: new Date(q.to) });
      // Rupee values only for staff allowed to see revenue.
      if (staff.permissions.has("reports.revenue")) return f;
      return {
        channels: f.channels.map((ch) => ({ ...ch, revenuePaise: null })),
        totals: { ...f.totals, revenuePaise: null },
      };
    }),
  );

  app.get("/v1/leads/:id", (request) =>
    deps.staff.inClinic(request, "patients.read", (c) => leadDetail(c, parse(idParams, request.params).id)),
  );

  // Leads from elsewhere: Practo, JustDial, the website, a walk-in enquiry, a phone call.
  app.post("/v1/leads", (request) =>
    deps.staff
      .inClinic(request, "patients.write", async (c, staff) => {
        const b = parse(
          z.object({
            source: z.enum(["website", "practo", "justdial", "walk_in", "phone", "referral", "other"]),
            name: z.string().trim().min(1).max(100),
            phone: z.string().trim().min(6).max(20),
            need: z.enum(needs).nullish(),
            timing: z.enum(timings).nullish(),
            notes: z.string().trim().max(1000).nullish(),
            campaign: z.string().trim().max(200).nullish(),
          }),
          request.body,
        );
        return { staff, lead: await createLead(c, b) };
      })
      .then(async ({ staff, lead }) => {
        if (lead.created)
          await deps.jobs.add(
            "lead_kickoff",
            { clinicId: staff.clinicId },
            { jobKey: `lead-kickoff:${lead.id}` },
          );
        return lead;
      }),
  );

  app.post("/v1/leads/:id/outcome", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c, staff) => {
      const b = parse(
        z.object({
          outcome: z.enum(["booked", "callback", "no_answer", "not_interested", "wrong_number"]),
          note: z.string().trim().max(500).nullish(),
          callbackAt: z.string().datetime({ offset: true }).nullish(),
          need: z.enum(needs).nullish(),
          timing: z.enum(timings).nullish(),
        }),
        request.body,
      );
      const id = parse(idParams, request.params).id;
      if (b.need || b.timing)
        await qualifyLead(c, id, { need: b.need ?? undefined, timing: b.timing ?? undefined });
      await recordCallOutcome(c, id, {
        outcome: b.outcome,
        note: b.note,
        callbackAt: b.callbackAt ? new Date(b.callbackAt) : null,
        userId: staff.user.userId,
      });
      return { ok: true };
    }),
  );

  app.post("/v1/leads/:id/reopen", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      await reopenLead(c, parse(idParams, request.params).id);
      return { ok: true };
    }),
  );

  app.get("/v1/lead-settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => leadSettings(c)),
  );

  app.put("/v1/lead-settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const b = parse(
        z.object({
          alertPhone: z.string().trim().max(20).nullable().optional(),
          page: z
            .object({
              pageId: z.string().trim().min(5).max(25),
              pageName: z.string().trim().max(100).nullish(),
              pageAccessToken: z.string().trim().min(20).max(1000),
            })
            .optional(),
        }),
        request.body,
      );
      if (b.page) {
        if (!deps.channelKey)
          throw new HttpError(
            503,
            "not_configured",
            "Saving the Page token needs CHANNEL_SECRET_KEY on the server",
          );
        await connectMetaPage(c, deps.channelKey, b.page);
      }
      if (b.alertPhone !== undefined) await saveLeadAlertPhone(c, b.alertPhone || null);
      return leadSettings(c);
    }),
  );
}

import { ownerReport } from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http";
import type { StaffContextService } from "../staff-context";

/** The owner's report (day, week, month) and the nightly WhatsApp switch. */
export function reportRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/reports", (request) =>
    deps.staff.inClinic(request, "reports.revenue", (c) => {
      const q = parse(
        z.object({
          period: z.enum(["day", "week", "month"]).default("day"),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        request.query,
      );
      return ownerReport(c, q);
    }),
  );

  app.get("/v1/reports/settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const s = (await c.query("select settings from clinics where id = app.current_clinic_id()")).rows[0]
        .settings;
      return { nightly: s?.reports?.nightly !== false };
    }),
  );

  app.put("/v1/reports/settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const b = parse(z.object({ nightly: z.boolean() }), request.body);
      await c.query(
        `update clinics set settings = jsonb_set(settings, '{reports}', coalesce(settings->'reports', '{}'::jsonb) || jsonb_build_object('nightly', $1::boolean))
         where id = app.current_clinic_id()`,
        [b.nightly],
      );
      return b;
    }),
  );
}

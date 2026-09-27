import { saveTestMode, setupChecklist, tickSetupStep } from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http";
import type { StaffContextService } from "../staff-context";

/** The owner's setup checklist and test mode (PLAN Phase 6 onboarding). */
export function setupRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/setup", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => setupChecklist(c)),
  );

  app.put("/v1/setup/steps/:key", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => {
      const { key } = parse(z.object({ key: z.string().max(30) }), request.params);
      const b = parse(z.object({ done: z.boolean() }), request.body);
      return tickSetupStep(c, key, b.done);
    }),
  );

  app.put("/v1/test-mode", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => {
      const b = parse(
        z.object({ on: z.boolean(), phones: z.array(z.string().trim().max(20)).max(10).optional() }),
        request.body,
      );
      return saveTestMode(c, b);
    }),
  );
}

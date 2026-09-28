import { reviewSettings, saveReviewSettings } from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http";
import type { StaffContextService } from "../staff-context";

/** Google reviews: the clinic's review link and the after-visit question switch. */
export function reviewRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/reviews/settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => reviewSettings(c)),
  );

  app.put("/v1/reviews/settings", (request) =>
    deps.staff.inClinic(request, "settings.manage", (c) => {
      const b = parse(
        z.object({ enabled: z.boolean(), link: z.string().trim().max(500).nullable() }),
        request.body,
      );
      return saveReviewSettings(c, b);
    }),
  );
}

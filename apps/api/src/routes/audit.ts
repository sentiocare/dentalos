import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, uuid } from "../http.js";
import type { StaffContextService } from "../staff-context.js";

export function auditRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  // Who changed what, when (Build Prompt §5.15). Newest first, paged by id.
  app.get("/v1/audit", (request) =>
    deps.staff.inClinic(request, "audit.read", async (c) => {
      const q = parse(
        z.object({
          entity: z
            .string()
            .regex(/^[a-z_]+$/)
            .optional(),
          entityId: uuid.optional(),
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      const { rows } = await c.query(
        `select a.id, a.at, a.actor, a.action, a.entity, a.entity_id, a.before, a.after,
                coalesce(m.display_name, u.name) as actor_name
         from audit_log a
         left join users u on u.id = a.user_id
         left join clinic_memberships m on m.user_id = a.user_id and m.clinic_id = a.clinic_id
         where ($1::text is null or a.entity = $1) and ($2::uuid is null or a.entity_id = $2)
           and ($3::bigint is null or a.id < $3)
         order by a.id desc limit $4`,
        [q.entity ?? null, q.entityId ?? null, q.before ?? null, q.limit],
      );
      return rows;
    }),
  );
}

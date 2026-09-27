import {
  addWalkIn,
  assistantToday,
  deskCounts,
  isLocalDate,
  leaveQueue,
  listQueue,
  localDateOf,
  sendIn,
  visitBilling,
  visitCheckout,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParams, parse, uuid } from "../http";
import type { StaffContextService } from "../staff-context";

/** The reception desk: today's queue with tokens, walk-ins, checkout, and what needs attention. */
export function deskRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/desk", (request) =>
    deps.staff.inClinic(request, "appointments.read", async (c, staff) => {
      const q = parse(z.object({ date: z.string().refine(isLocalDate).optional() }), request.query);
      const tz = (await c.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
        .timezone;
      const date = q.date ?? localDateOf(new Date(), tz);
      const queue = await listQueue(c, date);
      const assistant = await assistantToday(c, date);
      let billing = null;
      if (staff.permissions.has("billing.read")) {
        const ids = (
          await c.query(
            `select id from appointments where status = 'completed'
               and starts_at >= (($1::date)::timestamp at time zone $2) and starts_at < (($1::date + 1)::timestamp at time zone $2)`,
            [date, tz],
          )
        ).rows.map((r) => r.id as string);
        billing = await visitBilling(c, ids);
      }
      return { date, queue, assistant, billing };
    }),
  );

  app.get("/v1/desk/counts", (request) =>
    deps.staff.inClinic(request, "appointments.read", (c) => deskCounts(c)),
  );

  app.post("/v1/queue", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c) =>
      addWalkIn(
        c,
        parse(
          z.object({
            patientId: uuid,
            doctorId: uuid.nullish(),
            procedureTypeId: uuid.nullish(),
            note: z.string().trim().max(300).nullish(),
          }),
          request.body,
        ),
      ),
    ),
  );

  app.post("/v1/queue/:id/send-in", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c, staff) => {
      const b = parse(z.object({ doctorId: uuid.optional(), chairId: uuid.optional() }), request.body ?? {});
      return sendIn(c, parse(idParams, request.params).id, { ...b, userId: staff.user.userId });
    }),
  );

  app.post("/v1/queue/:id/left", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c) => {
      await leaveQueue(c, parse(idParams, request.params).id);
      return { ok: true };
    }),
  );

  app.get("/v1/appointments/:id/checkout", (request) =>
    deps.staff.inClinic(request, "billing.read", (c) => visitCheckout(c, parse(idParams, request.params).id)),
  );
}

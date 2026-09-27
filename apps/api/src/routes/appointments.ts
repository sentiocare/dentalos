import {
  bookDirect,
  cancelAppointment,
  findSlots,
  listAppointments,
  moveAppointment,
  setAppointmentStatus,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParams, instant, localDate, parse, uuid } from "../http.js";
import type { StaffContextService } from "../staff-context.js";

const bookBody = z.object({
  patientId: uuid,
  doctorId: uuid,
  chairId: uuid,
  procedureTypeId: uuid.nullish(),
  branchId: uuid.optional(),
  startsAt: instant,
  endsAt: instant.optional(),
  notes: z.string().max(2000).optional(),
  acknowledgeWarnings: z.boolean().optional(),
  useEmergencyReserve: z.boolean().optional(),
  walkIn: z.boolean().optional(),
  // Sent by the dashboard with every change so a retry after a dropped connection never double-books.
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export function appointmentRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/appointments", (request) =>
    deps.staff.inClinic(request, "appointments.read", (c) => {
      const q = parse(
        z
          .object({
            from: instant,
            to: instant,
            branchId: uuid.optional(),
            includeCancelled: z.enum(["true", "false"]).optional(),
          })
          .refine(
            (v) => v.to > v.from && v.to.getTime() - v.from.getTime() <= 45 * 86_400_000,
            "range must be positive and at most 45 days",
          ),
        request.query,
      );
      return listAppointments(c, { ...q, includeCancelled: q.includeCancelled === "true" });
    }),
  );

  app.get("/v1/slots", (request) =>
    deps.staff.inClinic(request, "appointments.read", async (c) => {
      const q = parse(
        z.object({
          procedureId: uuid,
          fromDate: localDate.optional(),
          toDate: localDate.optional(),
          doctorId: uuid.optional(),
          branchId: uuid.optional(),
          partsOfDay: z
            .string()
            .optional()
            .transform((v) => (v ? v.split(",") : undefined))
            .pipe(z.array(z.enum(["morning", "afternoon", "evening"])).optional()),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      const slots = await findSlots(c, q);
      return slots.slice(0, q.limit);
    }),
  );

  app.post("/v1/appointments", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c, staff) => {
      const b = parse(bookBody, request.body);
      return bookDirect(c, {
        ...b,
        source: b.walkIn ? "walk_in" : "staff",
        bookedByUserId: staff.user.userId,
      });
    }),
  );

  // Drag, drop and resize on the calendar.
  app.patch("/v1/appointments/:id", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c) =>
      moveAppointment(
        c,
        parse(idParams, request.params).id,
        parse(
          z.object({
            startsAt: instant.optional(),
            endsAt: instant.optional(),
            doctorId: uuid.optional(),
            chairId: uuid.optional(),
            acknowledgeWarnings: z.boolean().optional(),
            useEmergencyReserve: z.boolean().optional(),
          }),
          request.body,
        ),
      ),
    ),
  );

  app.post("/v1/appointments/:id/status", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c) =>
      setAppointmentStatus(
        c,
        parse(idParams, request.params).id,
        parse(
          z.object({
            status: z.enum(["booked", "confirmed", "checked_in", "in_chair", "completed", "no_show"]),
          }),
          request.body,
        ).status,
      ),
    ),
  );

  app.post("/v1/appointments/:id/cancel", (request) =>
    deps.staff.inClinic(request, "appointments.write", (c) =>
      cancelAppointment(
        c,
        parse(idParams, request.params).id,
        parse(z.object({ reason: z.string().max(300).optional() }), request.body ?? {}).reason,
      ),
    ),
  );
}

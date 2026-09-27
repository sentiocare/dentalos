import {
  createPatient,
  deletePatient,
  getPatient,
  linkFamily,
  listFamily,
  listPatientAppointments,
  searchPatients,
  unlinkFamily,
  updatePatient,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParams, localDate, parse, uuid } from "../http";
import type { StaffContextService } from "../staff-context";

const patientBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().max(25).nullish(),
  altPhone: z.string().max(25).nullish(),
  dob: localDate.nullish(),
  approxBirthYear: z.number().int().min(1900).max(2100).nullish(),
  gender: z.enum(["female", "male", "other", "unknown"]).optional(),
  languagePref: z.string().max(10).nullish(),
  source: z.string().max(60).nullish(),
  referredByPatientId: uuid.nullish(),
  address: z.string().max(300).nullish(),
  city: z.string().max(80).nullish(),
  notes: z.string().max(4000).nullish(),
  fileNumber: z.string().max(40).nullish(),
});

export function patientRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/patients", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const q = parse(
        z.object({
          q: z.string().max(100).default(""),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
        request.query,
      );
      return searchPatients(c, q.q, q.limit);
    }),
  );

  app.post("/v1/patients", (request) =>
    deps.staff.inClinic(request, "patients.write", (c) => createPatient(c, parse(patientBody, request.body))),
  );

  app.get("/v1/patients/:id", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const { id } = parse(idParams, request.params);
      const [patient, family, appointments] = await Promise.all([
        getPatient(c, id),
        listFamily(c, id),
        listPatientAppointments(c, id),
      ]);
      return { patient, family, appointments };
    }),
  );

  app.patch("/v1/patients/:id", (request) =>
    deps.staff.inClinic(request, "patients.write", (c) =>
      updatePatient(c, parse(idParams, request.params).id, parse(patientBody.partial(), request.body)),
    ),
  );

  app.delete("/v1/patients/:id", (request) =>
    deps.staff.inClinic(request, "patients.delete", async (c) => {
      await deletePatient(c, parse(idParams, request.params).id);
      return { ok: true };
    }),
  );

  app.post("/v1/patients/:id/family", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      const { id } = parse(idParams, request.params);
      const b = parse(
        z.object({
          relatedPatientId: uuid,
          relationship: z.string().trim().min(1).max(40),
          isPrimaryContact: z.boolean().optional(),
        }),
        request.body,
      );
      return { id: await linkFamily(c, { patientId: id, ...b }) };
    }),
  );

  app.delete("/v1/family-links/:id", (request) =>
    deps.staff.inClinic(request, "patients.write", async (c) => {
      await unlinkFamily(c, parse(idParams, request.params).id);
      return { ok: true };
    }),
  );
}

import {
  commitAppointmentImport,
  commitPatientImport,
  guessAppointmentMapping,
  guessMapping,
  localDateOf,
  previewAppointmentImport,
  previewPatientImport,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { localDate, parse, uuid } from "../http.js";
import type { StaffContextService } from "../staff-context.js";

const MAX_ROWS = 20_000;
// Imports carry whole registers; allow bigger bodies on these routes only.
const bodyLimit = 25 * 1024 * 1024;

const rows = z
  .array(z.record(z.string(), z.string().max(2000).optional()))
  .min(1)
  .max(MAX_ROWS);
const mapping = z.record(z.string(), z.string()).optional();

const importedPatient = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().nullable(),
  altPhone: z.string().nullable(),
  dob: localDate.nullable(),
  approxBirthYear: z.number().int().nullable(),
  gender: z.enum(["female", "male", "other", "unknown"]),
  address: z.string().nullable(),
  city: z.string().nullable(),
  notes: z.string().nullable(),
  fileNumber: z.string().nullable(),
  source: z.string().nullable(),
});

export function importRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.post("/v1/imports/patients/preview", { bodyLimit }, (request) =>
    deps.staff.inClinic(request, "patients.import", async (c) => {
      const b = parse(z.object({ rows, mapping }), request.body);
      const used = b.mapping ?? guessMapping(Object.keys(b.rows[0] ?? {}));
      const timezone = (await c.query("select timezone from clinics where id = app.current_clinic_id()"))
        .rows[0].timezone;
      const preview = await previewPatientImport(c, b.rows, used, localDateOf(new Date(), timezone));
      return { mapping: used, rows: preview };
    }),
  );

  app.post("/v1/imports/patients/commit", { bodyLimit }, (request) =>
    deps.staff.inClinic(request, "patients.import", (c) => {
      const b = parse(
        z.object({
          decisions: z
            .array(
              z.object({
                action: z.enum(["create", "merge", "skip"]),
                value: importedPatient.nullable(),
                mergeIntoId: uuid.optional(),
              }),
            )
            .max(MAX_ROWS),
        }),
        request.body,
      );
      return commitPatientImport(c, b.decisions);
    }),
  );

  app.post("/v1/imports/appointments/preview", { bodyLimit }, (request) =>
    deps.staff.inClinic(request, "patients.import", async (c) => {
      const b = parse(z.object({ rows: rows.max(5000), mapping }), request.body);
      const used = b.mapping ?? guessAppointmentMapping(Object.keys(b.rows[0] ?? {}));
      const timezone = (await c.query("select timezone from clinics where id = app.current_clinic_id()"))
        .rows[0].timezone;
      return {
        mapping: used,
        rows: await previewAppointmentImport(c, b.rows, used, localDateOf(new Date(), timezone)),
      };
    }),
  );

  app.post("/v1/imports/appointments/commit", { bodyLimit }, (request) =>
    deps.staff.inClinic(request, "patients.import", (c) => {
      const b = parse(
        z.object({
          rows: z
            .array(
              z.object({
                row: z.number().int(),
                issues: z.array(z.string()),
                importable: z.boolean(),
                value: z
                  .object({
                    date: localDate,
                    startMin: z.number().int().min(0).max(1440),
                    endMin: z.number().int().min(1).max(1440),
                    patientName: z.string().min(1).max(120),
                    phone: z.string().nullable(),
                    existingPatientId: uuid.nullable(),
                    doctorId: uuid,
                    procedureTypeId: uuid.nullable(),
                    chairId: uuid.nullable(),
                    notes: z.string().nullable(),
                  })
                  .optional(),
              }),
            )
            .max(5000),
        }),
        request.body,
      );
      return commitAppointmentImport(c, b.rows as Parameters<typeof commitAppointmentImport>[1]);
    }),
  );
}

import type { StorageProvider } from "@dentalos/adapters";
import {
  cancelPrescription,
  listNotes,
  listPrescriptions,
  listRxTemplates,
  recordTooth,
  removeRxTemplate,
  renderPrescriptionPdf,
  saveNote,
  saveRxTemplate,
  scheduleSend,
  sendPrescription,
  TOOTH_CONDITIONS,
  toothChart,
  writePrescription,
  type JobQueue,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse, uuid } from "../http";
import type { StaffContextService } from "../staff-context";

const text = (max: number) => z.string().max(max).nullish();
const rxItem = z.object({
  drug: z.string().trim().min(1).max(120),
  dose: text(60),
  frequency: text(60),
  duration: text(60),
  instructions: text(160),
});

/** The doctor's record: case notes, tooth chart, prescriptions (read: clinical.read; write: doctors). */
export function clinicalRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; storage: StorageProvider; jobs: JobQueue },
) {
  app.get("/v1/patients/:id/clinical", (request) =>
    deps.staff.inClinic(request, "clinical.read", async (c) => {
      const id = parse(idParams, request.params).id;
      const notes = await listNotes(c, id);
      const chart = await toothChart(c, id);
      const prescriptions = await listPrescriptions(c, id);
      return { notes, chart, prescriptions };
    }),
  );

  app.post("/v1/patients/:id/notes", (request) =>
    deps.staff.inClinic(request, "clinical.write", (c, staff) => {
      const b = parse(
        z.object({
          appointmentId: uuid.nullish(),
          doctorId: uuid.nullish(),
          complaint: text(4000),
          findings: text(4000),
          diagnosis: text(4000),
          treatment: text(4000),
          advice: text(4000),
        }),
        request.body,
      );
      return saveNote(c, { ...b, patientId: parse(idParams, request.params).id, userId: staff.user.userId });
    }),
  );

  app.post("/v1/patients/:id/teeth", (request) =>
    deps.staff.inClinic(request, "clinical.write", (c, staff) => {
      const b = parse(
        z.object({
          tooth: z.number().int(),
          condition: z.enum(TOOTH_CONDITIONS),
          surfaces: text(10),
          note: text(300),
          appointmentId: uuid.nullish(),
        }),
        request.body,
      );
      return recordTooth(c, {
        ...b,
        patientId: parse(idParams, request.params).id,
        userId: staff.user.userId,
      });
    }),
  );

  app.get("/v1/rx-templates", (request) =>
    deps.staff.inClinic(request, "clinical.read", (c) => listRxTemplates(c)),
  );

  const templateBody = z.object({
    name: z.string().trim().min(1).max(80),
    doctorId: uuid.nullish(),
    items: z.array(rxItem).min(1).max(10),
    advice: text(1000),
  });
  app.post("/v1/rx-templates", (request) =>
    deps.staff.inClinic(request, "clinical.write", (c) =>
      saveRxTemplate(c, parse(templateBody, request.body)),
    ),
  );
  app.put("/v1/rx-templates/:id", (request) =>
    deps.staff.inClinic(request, "clinical.write", (c) =>
      saveRxTemplate(c, { ...parse(templateBody, request.body), id: parse(idParams, request.params).id }),
    ),
  );
  app.delete("/v1/rx-templates/:id", (request) =>
    deps.staff.inClinic(request, "clinical.write", async (c) => {
      await removeRxTemplate(c, parse(idParams, request.params).id);
      return { ok: true };
    }),
  );

  app.post("/v1/patients/:id/prescriptions", (request) =>
    deps.staff
      .inClinic(request, "clinical.write", async (c, staff) => {
        const b = parse(
          z.object({
            doctorId: uuid,
            appointmentId: uuid.nullish(),
            items: z.array(rxItem).min(1).max(10),
            advice: text(1000),
            reviewOn: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullish(),
            send: z.boolean().default(false),
          }),
          request.body,
        );
        const rx = await writePrescription(c, {
          ...b,
          patientId: parse(idParams, request.params).id,
          userId: staff.user.userId,
        });
        const sent = b.send ? await sendPrescription(c, rx.id, { storage: deps.storage }) : null;
        return { staff, rx, outboxId: sent?.outboxId ?? null };
      })
      .then(async ({ staff, rx, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ...rx, sent: !!outboxId };
      }),
  );

  app.post("/v1/prescriptions/:id/cancel", (request) =>
    deps.staff.inClinic(request, "clinical.write", async (c) => {
      const b = parse(z.object({ reason: z.string().trim().min(1).max(300) }), request.body);
      await cancelPrescription(c, parse(idParams, request.params).id, b.reason);
      return { ok: true };
    }),
  );

  app.post("/v1/prescriptions/:id/send", (request) =>
    deps.staff
      .inClinic(request, "clinical.read", async (c, staff) => ({
        staff,
        ...(await sendPrescription(c, parse(idParams, request.params).id, { storage: deps.storage })),
      }))
      .then(async ({ staff, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ok: true, queued: !!outboxId };
      }),
  );

  app.get("/v1/prescriptions/:id/pdf", (request, reply) =>
    deps.staff
      .inClinic(request, "clinical.read", async (c) => {
        const id = parse(idParams, request.params).id;
        const row = (await c.query("select number from prescriptions where id = $1", [id])).rows[0];
        if (!row) throw new HttpError(404, "not_found", "Prescription not found");
        return { bytes: await renderPrescriptionPdf(c, id), name: row.number as string };
      })
      .then(({ bytes, name }) =>
        reply
          .type("application/pdf")
          .header("content-disposition", `inline; filename="${name.replace(/[^\w.-]+/g, "-")}.pdf"`)
          .send(Buffer.from(bytes)),
      ),
  );
}

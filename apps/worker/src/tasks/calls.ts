import { checkConfirmationCall, checkLeadCall, recordOutboundCall } from "@dentalos/agent";
import type { CallRequest } from "@dentalos/core";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";

/**
 * Places an AI call asked for by the follow-up engine: confirming an appointment, or calling a new lead to
 * qualify them and book a consultation. Every rule is checked again right before dialling (the appointment may
 * have been confirmed or moved, the lead may have booked or replied on WhatsApp, anyone may have opted out).
 * If the call can't be placed, the ladder's next steps (messages, a staff task) take over.
 */
export function makePlaceCallTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "logger">) {
  return async (payload: unknown, _helpers: JobHelpers) => {
    const request = payload as CallRequest & { clinicId: string };
    // Jobs queued before lead calls existed carry no purpose: they are confirmation calls.
    const purpose = request.purpose ?? "confirm_appointment";
    const subjectId =
      purpose === "lead_call"
        ? (request as { leadId: string }).leadId
        : (request as { appointmentId: string }).appointmentId;
    const check =
      purpose === "lead_call"
        ? await checkLeadCall(deps.pool, request.clinicId, subjectId)
        : await checkConfirmationCall(deps.pool, request.clinicId, subjectId);
    if (!check.ok) {
      deps.logger.info({ clinicId: request.clinicId, purpose, reason: check.reason }, "AI call not placed");
      return;
    }
    const telephony = deps.adapters.telephony;
    const { providerCallId } = await telephony.placeCall({
      to: check.phone,
      callerId: check.callerId,
      flowId: check.flowId,
      clientRef: `${purpose === "lead_call" ? "lead" : "confirm"}:${subjectId}`,
    });
    await recordOutboundCall(deps.pool, {
      clinicId: request.clinicId,
      provider: telephony.name,
      providerCallId,
      purpose,
      subjectId,
      phone: check.phone,
      callerId: check.callerId,
      patientId: check.patientId,
    });
  };
}

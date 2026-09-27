import { checkConfirmationCall, recordOutboundCall } from "@dentalos/agent";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";

/**
 * Places an AI confirmation call asked for by the follow-up engine. Every rule is checked again right before
 * dialling (the appointment may have been confirmed or moved, the patient may have opted out). If the call
 * can't be placed, the ladder's next step (a staff task) takes over.
 */
export function makePlaceCallTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "logger">) {
  return async (payload: unknown, _helpers: JobHelpers) => {
    const { clinicId, appointmentId } = payload as {
      clinicId: string;
      appointmentId: string;
      runId: string;
      step: number;
    };
    const check = await checkConfirmationCall(deps.pool, clinicId, appointmentId);
    if (!check.ok) {
      deps.logger.info({ clinicId, reason: check.reason }, "confirmation call not placed");
      return;
    }
    const telephony = deps.adapters.telephony;
    const { providerCallId } = await telephony.placeCall({
      to: check.phone,
      callerId: check.callerId,
      flowId: check.flowId,
      clientRef: `confirm:${appointmentId}`,
    });
    await recordOutboundCall(deps.pool, {
      clinicId,
      provider: telephony.name,
      providerCallId,
      appointmentId,
      phone: check.phone,
      callerId: check.callerId,
      patientId: check.patientId,
    });
  };
}

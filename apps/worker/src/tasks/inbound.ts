import { processInboundMessage } from "@dentalos/agent";
import { getWhatsAppChannel } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import { queueFromHelpers, type OutboxTaskDeps } from "./outbox";

/** Runs the WhatsApp assistant for one patient message (queued by the webhook). */
export function makeProcessInboundTask(deps: OutboxTaskDeps) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId, messageId } = payload as { clinicId: string; messageId: string };
    await processInboundMessage(
      {
        pool: deps.pool,
        jobs: queueFromHelpers(helpers),
        llm: deps.adapters.llm,
        voice: deps.adapters.voice,
        messaging: deps.adapters.messaging,
        channel: async (id) =>
          deps.channelKey
            ? withClinic(deps.pool, { clinicId: id, actor: "job:process_inbound" }, (c) =>
                getWhatsAppChannel(c, deps.channelKey!),
              )
            : null,
      },
      clinicId,
      messageId,
    );
  };
}

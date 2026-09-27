import type { Adapters } from "@dentalos/adapters";
import { getWhatsAppChannel, processOutbox, scheduleSend, type JobQueue } from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import type { Logger } from "@dentalos/shared/logger";
import type { JobHelpers } from "graphile-worker";

export interface OutboxTaskDeps {
  pool: Pool;
  adapters: Adapters;
  logger: Logger;
  channelKey: Buffer | null;
}

export function queueFromHelpers(helpers: JobHelpers): JobQueue {
  return {
    add: async (task, payload, options = {}) => {
      await helpers.addJob(task, payload, {
        jobKey: options.jobKey,
        runAt: options.runAt,
        queueName: options.queueName,
      });
    },
  };
}

/** Sends one queued message. Retries are rescheduled for the time the outbox decided. */
export function makeSendOutboxTask(deps: OutboxTaskDeps) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const { clinicId, outboxId } = payload as { clinicId: string; outboxId: string };
    const outcome = await withClinic(
      deps.pool,
      { clinicId, actor: "job:send_outbox", role: "system" },
      (client) =>
        processOutbox(client, outboxId, {
          messaging: deps.adapters.messaging,
          channel: async (c) => (deps.channelKey ? getWhatsAppChannel(c, deps.channelKey) : null),
        }),
    );
    if (outcome.status === "retry")
      await scheduleSend(queueFromHelpers(helpers), clinicId, outboxId, outcome.at);
    if (outcome.status === "failed")
      deps.logger.warn({ outboxId, reason: outcome.reason }, "message could not be sent");
  };
}

/**
 * Safety net, every minute: queues any due message that has no job (e.g. the API crashed between saving and
 * queueing) and releases rows stuck in "sending" after a worker crash.
 */
export function makeOutboxSweepTask(deps: Pick<OutboxTaskDeps, "pool">) {
  return async (_payload: unknown, helpers: JobHelpers) => {
    await deps.pool.query(
      "update outbox set status = 'pending' where status = 'sending' and not_before < now() - interval '10 minutes'",
    );
    const { rows } = await deps.pool.query(
      "select id, clinic_id from outbox where status = 'pending' and not_before <= now() order by not_before limit 500",
    );
    const queue = queueFromHelpers(helpers);
    for (const r of rows) await scheduleSend(queue, r.clinic_id, r.id);
  };
}

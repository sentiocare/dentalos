import { planAppointmentMessages, scheduleSend } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import { queueFromHelpers, type OutboxTaskDeps } from "./outbox";

/**
 * Every minute (and right after staff change an appointment): plan confirmations, reminders and
 * notices for clinics with WhatsApp connected, then queue anything already due.
 */
export function makePlanMessagesTask(deps: Pick<OutboxTaskDeps, "pool" | "logger">) {
  return async (payload: unknown, helpers: JobHelpers) => {
    const only = (payload as { clinicId?: string } | null)?.clinicId;
    const { rows } = await deps.pool.query(
      `select distinct clinic_id from clinic_channels where kind = 'whatsapp' and active and ($1::uuid is null or clinic_id = $1)`,
      [only ?? null],
    );
    const queue = queueFromHelpers(helpers);
    for (const { clinic_id: clinicId } of rows) {
      const due = await withClinic(
        deps.pool,
        { clinicId, actor: "job:plan_messages", role: "system" },
        async (c) => {
          const result = await planAppointmentMessages(c);
          if (result.queued || result.tasks)
            deps.logger.info({ clinicId, ...result }, "appointment messages planned");
          return (
            await c.query("select id from outbox where status = 'pending' and not_before <= now() limit 200")
          ).rows;
        },
      );
      for (const r of due) await scheduleSend(queue, clinicId, r.id);
    }
  };
}

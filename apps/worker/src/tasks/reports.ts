import { queueNightlyReport, scheduleSend } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";
import { queueFromHelpers } from "./outbox";

/** Hourly: every clinic where it is now 9 pm gets its day's summary on WhatsApp (once per day). */
export function makeOwnerReportTask(deps: Pick<WorkerDeps, "pool" | "logger" | "dashboardUrl">) {
  return async (_payload: unknown, helpers: JobHelpers) => {
    const queue = queueFromHelpers(helpers);
    const { rows } = await deps.pool.query("select id from clinics");
    for (const { id: clinicId } of rows) {
      try {
        const outboxId = await withClinic(
          deps.pool,
          { clinicId, actor: "job:owner_report", role: "system" },
          (c) => queueNightlyReport(c, { now: new Date(), dashboardUrl: deps.dashboardUrl }),
        );
        if (outboxId) await scheduleSend(queue, clinicId, outboxId);
      } catch (error) {
        deps.logger.warn({ clinicId, err: error }, "owner report failed");
      }
    }
  };
}

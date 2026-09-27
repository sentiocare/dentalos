import { scheduleSend, walletNotices } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import type { JobHelpers } from "graphile-worker";
import type { WorkerDeps } from "../worker";
import { queueFromHelpers } from "./outbox";

/**
 * Every few minutes: tell each owner when their usage wallet runs low or pauses (with a top-up link), and
 * when this month's spending passes 50%, 80% and 100% of their limit. Each notice goes once.
 */
export function makeWalletWatchTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "logger">) {
  return async (_payload: unknown, helpers: JobHelpers) => {
    const queue = queueFromHelpers(helpers);
    const { rows } = await deps.pool.query("select clinic_id from wallets where enforced");
    for (const { clinic_id: clinicId } of rows) {
      try {
        const ids = await withClinic(
          deps.pool,
          { clinicId, actor: "job:wallet_watch", role: "system" },
          (c) => walletNotices(c, { payments: deps.adapters.payments }),
        );
        for (const id of ids) await scheduleSend(queue, clinicId, id);
      } catch (error) {
        deps.logger.warn({ clinicId, err: error }, "wallet notices failed");
      }
    }
  };
}

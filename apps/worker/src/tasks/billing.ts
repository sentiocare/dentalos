import { debitDueRecharges, planRecharges, reconcile, scheduleSend, walletNotices } from "@dentalos/core";
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

/** Hourly: announce the auto-recharges the forecast says are needed (the debit follows 24 hours later). */
export function makeRechargeForecastTask(deps: Pick<WorkerDeps, "pool" | "logger">) {
  return async (_payload: unknown, helpers: JobHelpers) => {
    const planned = await planRecharges(deps.pool);
    const queue = queueFromHelpers(helpers);
    for (const p of planned) if (p.outboxId) await scheduleSend(queue, p.clinicId, p.outboxId);
    if (planned.length) deps.logger.info({ recharges: planned.length }, "auto-recharges announced");
  };
}

/** Every 15 minutes: debit the announced recharges whose 24-hour notice has passed. */
export function makeRechargeDebitTask(deps: Pick<WorkerDeps, "pool" | "adapters" | "logger" | "seller">) {
  return async () => {
    const r = await debitDueRecharges(deps.pool, { payments: deps.adapters.payments, seller: deps.seller });
    if (r.debited || r.failed || r.cancelled) deps.logger.info(r, "recharge debits");
  };
}

/**
 * Nightly: yesterday's usage against provider bills where a provider reports them automatically (none of
 * the current adapters do yet; Sentio enters bills in the admin panel), and every wallet against its ledger.
 */
export function makeReconcileTask(deps: Pick<WorkerDeps, "pool" | "logger">) {
  return async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const rows = await reconcile(deps.pool, { periodStart: day, periodEnd: day, bills: {} });
    const off = rows.filter((r) => r.status === "drift");
    if (off.length) deps.logger.warn({ drift: off.map((r) => r.provider) }, "reconciliation drift");
  };
}

import type { Adapters } from "@dentalos/adapters";
import type { SentioSeller } from "@dentalos/core";
import type { Pool } from "@dentalos/db";
import type { Logger } from "@dentalos/shared/logger";
import { Logger as GraphileLogger, type TaskList } from "graphile-worker";
import { makeHeartbeatTask } from "./tasks/heartbeat";
import { makeProcessInboundTask } from "./tasks/inbound";
import { makePlanMessagesTask } from "./tasks/plan-messages";
import { makeOutboxSweepTask, makeSendOutboxTask } from "./tasks/outbox";
import { makePlaceCallTask } from "./tasks/calls";
import { makeFetchLeadTask, makeLeadKickoffTask, makeLeadSignalsTask } from "./tasks/leads";
import { makeOwnerReportTask } from "./tasks/reports";
import {
  makeRechargeDebitTask,
  makeRechargeForecastTask,
  makeReconcileTask,
  makeWalletWatchTask,
} from "./tasks/billing";
import { makeFollowupsTask, makeRequestDepositTask, makeSendReceiptTask } from "./tasks/followups";
import { makeFetchRecordingTask, makePurgeRecordingsTask } from "./tasks/recordings";
import { makeEmergencyReservesTask, makeSweepHoldsTask } from "./tasks/scheduling";

/**
 * Every job is idempotent: handlers must be safe to run twice (a crash after doing the work but before
 * marking the job done causes a retry). Jobs that must not be queued twice use a `jobKey`.
 */
export interface WorkerDeps {
  pool: Pool;
  version: string;
  logger: Logger;
  adapters: Adapters;
  channelKey: Buffer | null;
  /** Sentio's details for its GST invoices (recharges). */
  seller: SentioSeller;
  /** The dashboard's address, for links in messages to owners. */
  dashboardUrl?: string | null;
}

export function buildTaskList(deps: WorkerDeps): TaskList {
  return {
    heartbeat: makeHeartbeatTask(deps),
    sweep_holds: makeSweepHoldsTask(deps),
    emergency_reserves: makeEmergencyReservesTask(deps),
    send_outbox: makeSendOutboxTask(deps),
    outbox_sweep: makeOutboxSweepTask(deps),
    process_inbound: makeProcessInboundTask(deps),
    plan_messages: makePlanMessagesTask(deps),
    fetch_recording: makeFetchRecordingTask(deps),
    purge_recordings: makePurgeRecordingsTask(deps),
    followups: makeFollowupsTask(deps),
    request_deposit: makeRequestDepositTask(deps),
    send_receipt: makeSendReceiptTask(deps),
    place_call: makePlaceCallTask(deps),
    wallet_watch: makeWalletWatchTask(deps),
    fetch_lead: makeFetchLeadTask(deps),
    lead_kickoff: makeLeadKickoffTask(deps),
    lead_signals: makeLeadSignalsTask(deps),
    owner_report: makeOwnerReportTask(deps),
    recharge_forecast: makeRechargeForecastTask(deps),
    recharge_debit: makeRechargeDebitTask(deps),
    reconcile: makeReconcileTask(deps),
  };
}

/** Recurring schedule. Times are in IST where clinic-facing work depends on local time (added in later phases). */
export const CRONTAB = [
  "* * * * * heartbeat",
  "* * * * * sweep_holds",
  "* * * * * outbox_sweep",
  "* * * * * plan_messages",
  "*/5 * * * * followups",
  "*/5 * * * * wallet_watch",
  "13 * * * * recharge_forecast",
  // Hourly; each clinic's report goes at 21:00 in its own time zone.
  "2 * * * * owner_report",
  "*/15 * * * * recharge_debit",
  "*/15 * * * * lead_signals",
  // 03:30 IST (22:00 UTC): yesterday's usage against provider bills, wallets against their ledgers.
  "0 22 * * * reconcile",
  // Hourly, and backfilled after downtime so reserves never lapse.
  "7 * * * * emergency_reserves ?fill=6h",
  // 02:30 IST (21:00 UTC), when no clinic is open.
  "0 21 * * * purge_recordings",
].join("\n");

/**
 * Routes Graphile Worker's internal logs through our PII-scrubbing logger. Job payloads are never logged;
 * only identifiers needed to trace a job are kept.
 */
export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    const job = (meta as { job?: Record<string, unknown> } | undefined)?.job;
    const fields = {
      scope: scope.label,
      task: scope.taskIdentifier,
      job: job && { id: job.id, task: job.task_identifier, key: job.key, attempts: job.attempts },
    };
    const method =
      level === "error" ? "error" : level === "warning" ? "warn" : level === "debug" ? "debug" : "info";
    logger[method](fields, message);
  });
}

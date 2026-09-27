import type { Pool } from "@dentalos/db";
import type { Logger } from "@dentalos/shared/logger";
import { Logger as GraphileLogger, type TaskList } from "graphile-worker";
import { makeHeartbeatTask } from "./tasks/heartbeat.js";

/**
 * Every job is idempotent: handlers must be safe to run twice (a crash after doing the work but before
 * marking the job done causes a retry). Jobs that must not be queued twice use a `jobKey`.
 */
export function buildTaskList(deps: { pool: Pool; version: string }): TaskList {
  return {
    heartbeat: makeHeartbeatTask(deps),
  };
}

/** Recurring schedule. Times are in IST where clinic-facing work depends on local time (added in later phases). */
export const CRONTAB = ["* * * * * heartbeat"].join("\n");

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

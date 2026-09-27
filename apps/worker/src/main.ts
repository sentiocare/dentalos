import { createPool } from "@dentalos/db";
import { createLogger } from "@dentalos/shared/logger";
import { run } from "graphile-worker";
import { loadConfig } from "./config.js";
import { buildTaskList, CRONTAB, graphileLogger } from "./worker.js";

const config = loadConfig();
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL, {
  max: config.WORKER_CONCURRENCY + 2,
  onError: (err) => logger.warn({ err }, "idle database connection lost"),
});

const runner = await run({
  pgPool: pool,
  concurrency: config.WORKER_CONCURRENCY,
  taskList: buildTaskList({ pool, version: config.GIT_SHA }),
  crontab: CRONTAB,
  logger: graphileLogger(logger),
  noHandleSignals: false,
});

// Report liveness immediately instead of waiting for the first cron minute.
await runner.addJob("heartbeat", {}, { jobKey: "heartbeat:startup" });
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker started");
await runner.promise;
await pool.end();

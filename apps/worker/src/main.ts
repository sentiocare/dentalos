import { sellerFromEnv } from "@dentalos/core";
import { adapterOptions, adapterSelection, createAdapters } from "@dentalos/adapters";
import { createPool } from "@dentalos/db";
import { parseSecretKey } from "@dentalos/shared";
import { createLogger } from "@dentalos/shared/logger";
import { run } from "graphile-worker";
import { loadConfig } from "./config";
import { buildTaskList, CRONTAB, graphileLogger } from "./worker";

const config = loadConfig();
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL, {
  max: config.WORKER_CONCURRENCY + 2,
  onError: (err) => logger.warn({ err }, "idle database connection lost"),
});

const runner = await run({
  pgPool: pool,
  concurrency: config.WORKER_CONCURRENCY,
  taskList: buildTaskList({
    pool,
    version: config.GIT_SHA,
    logger,
    adapters: createAdapters(adapterSelection(config), adapterOptions(config)),
    channelKey: config.CHANNEL_SECRET_KEY ? parseSecretKey(config.CHANNEL_SECRET_KEY) : null,
    seller: sellerFromEnv(config),
  }),
  crontab: CRONTAB,
  logger: graphileLogger(logger),
  noHandleSignals: false,
});

// Report liveness immediately instead of waiting for the first cron minute.
await runner.addJob("heartbeat", {}, { jobKey: "heartbeat:startup" });
logger.info({ concurrency: config.WORKER_CONCURRENCY }, "worker started");
await runner.promise;
await pool.end();

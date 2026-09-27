import { adapterOptions, adapterSelection, createAdapters } from "@dentalos/adapters";
import { createPool } from "@dentalos/db";
import { parseSecretKey } from "@dentalos/shared";
import { makeWorkerUtils } from "graphile-worker";
import { createLogger } from "@dentalos/shared/logger";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { initErrorTracking } from "./observability";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
initErrorTracking({ dsn: config.SENTRY_DSN, environment: config.APP_ENV, release: config.GIT_SHA });

const pool = createPool(config.DATABASE_URL, {
  onError: (err) => logger.warn({ err }, "idle database connection lost"),
});
// Jobs are added straight into the worker's queue in Postgres.
const workerUtils = await makeWorkerUtils({ pgPool: pool });
await workerUtils.migrate();
const jobs = {
  add: async (
    task: string,
    payload: Record<string, unknown>,
    options: { jobKey?: string; runAt?: Date } = {},
  ) => {
    await workerUtils.addJob(task, payload, { jobKey: options.jobKey, runAt: options.runAt });
  },
};

const app = buildApp({
  jobs,
  channelKey: config.CHANNEL_SECRET_KEY ? parseSecretKey(config.CHANNEL_SECRET_KEY) : null,
  pool,
  adapters: createAdapters(adapterSelection(config), adapterOptions(config)),
  logger,
  version: config.GIT_SHA,
  auth: {
    jwksUrl: config.AUTH_JWKS_URL,
    jwtSecret: config.AUTH_JWT_SECRET,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    devLogin: config.DEV_LOGIN === "on",
  },
  webOrigins: config.WEB_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await app.close();
  await workerUtils.release();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });

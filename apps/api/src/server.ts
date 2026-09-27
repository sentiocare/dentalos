import { createAdapters } from "@dentalos/adapters";
import { createPool } from "@dentalos/db";
import { createLogger } from "@dentalos/shared/logger";
import { buildApp } from "./app.js";
import { adapterSelection, loadConfig } from "./config.js";
import { initErrorTracking } from "./observability.js";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
initErrorTracking({ dsn: config.SENTRY_DSN, environment: config.APP_ENV, release: config.GIT_SHA });

const pool = createPool(config.DATABASE_URL, {
  onError: (err) => logger.warn({ err }, "idle database connection lost"),
});
const app = buildApp({
  pool,
  adapters: createAdapters(adapterSelection(config)),
  logger,
  version: config.GIT_SHA,
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });

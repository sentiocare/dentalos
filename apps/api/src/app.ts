import type { Adapters } from "@dentalos/adapters";
import type { Pool } from "@dentalos/db";
import { uuidv7 } from "@dentalos/shared";
import type { Logger } from "@dentalos/shared/logger";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  pool: Pool;
  adapters: Adapters;
  logger: Logger;
  version: string;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => uuidv7(),
    bodyLimit: 1_048_576,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    // Internal details never go back to the client.
    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : error.message,
      requestId: request.id,
    });
  });

  void app.register(healthRoutes, deps);
  return app;
}

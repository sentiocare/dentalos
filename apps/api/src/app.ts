import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Adapters } from "@dentalos/adapters";
import type { JobQueue } from "@dentalos/core";
import type { Pool } from "@dentalos/db";
import { uuidv7 } from "@dentalos/shared";
import type { Logger } from "@dentalos/shared/logger";
import Fastify from "fastify";
import { createTokenVerifier, type AuthConfig } from "./auth";
import { errorResponse } from "./http";
import { appointmentRoutes } from "./routes/appointments";
import { auditRoutes } from "./routes/audit";
import { healthRoutes } from "./routes/health";
import { importRoutes } from "./routes/imports";
import { meRoutes } from "./routes/me";
import { patientRoutes } from "./routes/patients";
import { settingsRoutes } from "./routes/settings";
import { staffRoutes } from "./routes/staff";
import { webhookRoutes } from "./routes/webhooks";
import { createStaffContext } from "./staff-context";

export interface AppDeps {
  pool: Pool;
  adapters: Adapters;
  logger: Logger;
  version: string;
  auth: AuthConfig & { devLogin?: boolean };
  webOrigins?: string[];
  rateLimitPerMinute?: number;
  /** Background jobs (Graphile Worker in production). */
  jobs: JobQueue;
  /** Decrypts clinics' provider credentials; null until CHANNEL_SECRET_KEY is set. */
  channelKey: Buffer | null;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => uuidv7(),
    bodyLimit: 1_048_576,
  });

  void app.register(cors, {
    origin: deps.webOrigins ?? false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "x-clinic-id"],
    maxAge: 86_400,
  });

  // Per signed-in person (or per IP before sign-in). Generous for a busy front desk; webhooks from
  // providers get a separate, higher allowance on their own routes.
  void app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.headers.authorization?.slice(-32) ?? request.ip,
    allowList: (request) => request.url.startsWith("/health"),
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => errorResponse(error, request, reply));

  const staff = createStaffContext({ pool: deps.pool, verify: createTokenVerifier(deps.auth) });

  void app.register(healthRoutes, deps);
  const devLogin =
    deps.auth.devLogin && deps.auth.jwtSecret
      ? { secret: deps.auth.jwtSecret, audience: deps.auth.audience }
      : undefined;
  void app.register(webhookRoutes, { pool: deps.pool, adapters: deps.adapters, jobs: deps.jobs });
  void app.register(async (api) => {
    meRoutes(api, { pool: deps.pool, staff, devLogin });
    settingsRoutes(api, { staff });
    staffRoutes(api, { staff });
    patientRoutes(api, { staff });
    appointmentRoutes(api, { staff, jobs: deps.jobs });
    importRoutes(api, { staff });
    auditRoutes(api, { staff });
  });
  return app;
}

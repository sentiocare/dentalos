import cors from "@fastify/cors";
import type { Adapters } from "@dentalos/adapters";
import type { Pool } from "@dentalos/db";
import { uuidv7 } from "@dentalos/shared";
import type { Logger } from "@dentalos/shared/logger";
import Fastify from "fastify";
import { createTokenVerifier, type AuthConfig } from "./auth.js";
import { errorResponse } from "./http.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { auditRoutes } from "./routes/audit.js";
import { healthRoutes } from "./routes/health.js";
import { importRoutes } from "./routes/imports.js";
import { meRoutes } from "./routes/me.js";
import { patientRoutes } from "./routes/patients.js";
import { settingsRoutes } from "./routes/settings.js";
import { staffRoutes } from "./routes/staff.js";
import { createStaffContext } from "./staff-context.js";

export interface AppDeps {
  pool: Pool;
  adapters: Adapters;
  logger: Logger;
  version: string;
  auth: AuthConfig & { devLogin?: boolean };
  webOrigins?: string[];
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
  void app.register(async (api) => {
    meRoutes(api, { pool: deps.pool, staff, devLogin });
    settingsRoutes(api, { staff });
    staffRoutes(api, { staff });
    patientRoutes(api, { staff });
    appointmentRoutes(api, { staff });
    importRoutes(api, { staff });
    auditRoutes(api, { staff });
  });
  return app;
}

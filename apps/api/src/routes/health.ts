import type { Adapters } from "@dentalos/adapters";
import { withAppRole, type Pool } from "@dentalos/db";
import type { FastifyPluginAsync } from "fastify";

/** A background worker that has not checked in for this long is reported as down. */
export const WORKER_STALE_AFTER_SEC = 180;

interface ComponentStatus {
  ok: boolean;
  detail?: string;
}

export const healthRoutes: FastifyPluginAsync<{ pool: Pool; adapters: Adapters; version: string }> = async (
  app,
  deps,
) => {
  // Liveness: the process is up. Used by Railway to restart a hung container.
  app.get("/health", async () => ({ ok: true, version: deps.version }));

  // Readiness: can we actually serve clinics? Used by uptime monitoring and the Sentio admin panel.
  app.get("/health/ready", async (_request, reply) => {
    const components: Record<string, ComponentStatus> = {};

    try {
      const ageSec = await withAppRole(deps.pool, async (c) => {
        const { rows } = await c.query<{ age: number | null }>(
          "select extract(epoch from now() - max(beat_at))::float8 as age from service_heartbeats where service = 'worker'",
        );
        return rows[0]?.age ?? null;
      });
      components.database = { ok: true };
      components.worker =
        ageSec !== null && ageSec < WORKER_STALE_AFTER_SEC
          ? { ok: true }
          : {
              ok: false,
              detail: ageSec === null ? "no heartbeat yet" : `last heartbeat ${Math.round(ageSec)}s ago`,
            };
    } catch {
      components.database = { ok: false, detail: "database unreachable" };
    }

    const providerChecks = await Promise.all(
      Object.entries(deps.adapters).map(async ([key, adapter]) => {
        try {
          const status = await adapter.healthCheck();
          return [key, { ok: status.ok, detail: status.detail }] as const;
        } catch {
          return [key, { ok: false, detail: "health check failed" }] as const;
        }
      }),
    );
    for (const [key, status] of providerChecks) components[`provider.${key}`] = status;

    // Only the database decides readiness: provider outages have fallbacks (Build Prompt §11) and must not
    // take the API down, but they are reported so the team is alerted.
    const ready = components.database?.ok === true;
    return reply.code(ready ? 200 : 503).send({ ok: ready, version: deps.version, components });
  });
};

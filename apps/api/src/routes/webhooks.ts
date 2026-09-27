import { ingestMessagingEvents } from "@dentalos/agent";
import type { Adapters } from "@dentalos/adapters";
import type { JobQueue } from "@dentalos/core";
import type { Pool } from "@dentalos/db";
import type { FastifyInstance } from "fastify";

/**
 * Provider webhooks. Signatures are checked over the exact bytes received, so this plugin keeps JSON
 * bodies as raw strings. Meta expects a fast 200: we only store and queue here; the worker does the rest.
 */
export async function webhookRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; adapters: Adapters; jobs: JobQueue },
) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 2 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.get("/webhooks/whatsapp", async (request, reply) => {
    const challenge = deps.adapters.messaging.verifySubscription?.(
      request.query as Record<string, string | undefined>,
    );
    if (!challenge) return reply.code(403).send({ error: "forbidden" });
    return reply.type("text/plain").send(challenge);
  });

  app.post(
    "/webhooks/whatsapp",
    { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const webhook = {
        headers: request.headers as Record<string, string | undefined>,
        rawBody: String(request.body ?? ""),
      };
      if (!deps.adapters.messaging.verifyWebhook(webhook)) {
        request.log.warn("whatsapp webhook with a bad signature");
        return reply.code(401).send({ error: "bad_signature" });
      }
      const events = deps.adapters.messaging.parseWebhook(webhook);
      const result = await ingestMessagingEvents(deps.pool, deps.jobs, events);
      if (result.unrouted)
        request.log.warn({ unrouted: result.unrouted }, "whatsapp events for an unknown number");
      return reply.send({ ok: true });
    },
  );
}

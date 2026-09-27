import { ingestMessagingEvents } from "@dentalos/agent";
import type { Adapters } from "@dentalos/adapters";
import { getPaymentAccount, ingestClinicPaymentEvent, type JobQueue } from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import type { FastifyInstance } from "fastify";

/**
 * Provider webhooks. Signatures are checked over the exact bytes received, so this plugin keeps JSON
 * bodies as raw strings. Meta expects a fast 200: we only store and queue here; the worker does the rest.
 */
export async function webhookRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; adapters: Adapters; jobs: JobQueue; channelKey: Buffer | null },
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

  // Patients paying a clinic, on the clinic's own gateway account: one webhook URL per clinic, verified
  // with that clinic's webhook secret.
  app.post(
    "/webhooks/payments/clinic/:clinicId",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { clinicId } = request.params as { clinicId: string };
      if (!/^[0-9a-f-]{36}$/i.test(clinicId)) return reply.code(404).send({ error: "not_found" });
      const webhook = {
        headers: request.headers as Record<string, string | undefined>,
        rawBody: String(request.body ?? ""),
      };
      const payments = deps.adapters.payments;
      const account = await withClinic(deps.pool, { clinicId, actor: "system", role: "system" }, (c) =>
        getPaymentAccount(c, deps.channelKey),
      );
      // Only the fake provider (tests, demo) may run without a connected account.
      if (!account && payments.name !== "fake-payments") return reply.code(404).send({ error: "not_found" });
      if (!payments.verifyWebhook(webhook, account ?? undefined)) {
        request.log.warn("payment webhook with a bad signature");
        return reply.code(401).send({ error: "bad_signature" });
      }
      for (const event of payments.parseWebhook(webhook, account ?? undefined)) {
        const result = await ingestClinicPaymentEvent(deps.pool, clinicId, event);
        if (result.receiptId)
          await deps.jobs.add(
            "send_receipt",
            { clinicId, receiptId: result.receiptId },
            { jobKey: `receipt:${result.receiptId}` },
          );
      }
      return reply.send({ ok: true });
    },
  );
}

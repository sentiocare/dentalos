import {
  handleUnansweredCall,
  recordCallStatus,
  routeInboundCall,
  transferTargets,
  voiceServiceHealthy,
} from "@dentalos/agent";
import type { Adapters, FlowHttpRequest, FlowHttpResponse } from "@dentalos/adapters";
import { scheduleSend, type JobQueue } from "@dentalos/core";
import type { Pool } from "@dentalos/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * The telephony provider's call flow asks these URLs what to do (docs/SETUP.md, "Connect phone calls"):
 *   /telephony/route            answer with the assistant (200) or ring the clinic (302)?
 *   /telephony/after-assistant  after the assistant: connect to a person (200) or hang up (302)?
 *   /telephony/connect          which numbers to ring, in order
 *   /telephony/missed           nobody picked up: call-back task + WhatsApp to the caller
 *   /telephony/status           end-of-call report: duration, recording
 * Every URL carries the secret token (`key=`). Answers must be fast: the caller is waiting on the line.
 */
export async function telephonyRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; adapters: Adapters; jobs: JobQueue },
) {
  const telephony = deps.adapters.telephony;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  const flowRequest = (request: FastifyRequest): FlowHttpRequest => ({
    params: {
      ...(request.query as Record<string, string | undefined>),
      ...(request.body && typeof request.body === "object" ? (request.body as Record<string, string>) : {}),
    },
    headers: request.headers as Record<string, string | undefined>,
  });
  const send = (reply: FastifyReply, res: FlowHttpResponse) =>
    reply.code(res.status).type(res.contentType).send(res.body);

  const handler =
    (fn: (req: FlowHttpRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const req = flowRequest(request);
      if (!telephony.verifyFlowRequest(req)) return reply.code(403).send({ error: "forbidden" });
      return fn(req, reply);
    };

  const routes: [string, (req: FlowHttpRequest, reply: FastifyReply) => Promise<unknown>][] = [
    [
      "/telephony/route",
      async (req, reply) => {
        const flow = telephony.parseFlowRequest(req);
        const routed = await routeInboundCall(
          deps.pool,
          { provider: telephony.name, providerCallId: flow.providerCallId, from: flow.from, to: flow.to },
          { voiceHealthy: await voiceServiceHealthy(deps.pool) },
        );
        return send(reply, telephony.flowResponse({ kind: "branch", yes: routed?.route === "assistant" }));
      },
    ],
    [
      "/telephony/after-assistant",
      async (req, reply) => {
        const flow = telephony.parseFlowRequest(req);
        const targets = await transferTargets(deps.pool, telephony.name, flow.providerCallId);
        return send(
          reply,
          telephony.flowResponse({ kind: "branch", yes: !!targets?.kind && targets.numbers.length > 0 }),
        );
      },
    ],
    [
      "/telephony/connect",
      async (req, reply) => {
        const flow = telephony.parseFlowRequest(req);
        const targets = await transferTargets(deps.pool, telephony.name, flow.providerCallId);
        if (!targets || targets.numbers.length === 0) return reply.code(404).send({ error: "no_numbers" });
        return send(
          reply,
          telephony.flowResponse({
            kind: "connect",
            numbers: targets.numbers,
            callerId: targets.callerId ?? undefined,
            ringSeconds: targets.kind === "emergency" ? 20 : 25,
            record: true,
            whisper:
              targets.kind === "emergency"
                ? "Emergency call from a patient. Connecting now."
                : targets.kind === "staff"
                  ? "Call from a patient, passed on by the assistant."
                  : undefined,
          }),
        );
      },
    ],
    [
      "/telephony/missed",
      async (req, reply) => {
        const flow = telephony.parseFlowRequest(req);
        const result = await handleUnansweredCall(
          deps.pool,
          telephony.name,
          flow.providerCallId,
          flow.dialStatus,
        );
        if (result?.outboxId) await scheduleSend(deps.jobs, result.clinicId, result.outboxId);
        return send(reply, telephony.flowResponse({ kind: "branch", yes: true }));
      },
    ],
    [
      "/telephony/status",
      async (req, reply) => {
        const event = telephony.parseStatusCallback(req);
        if (!event) return reply.send({ ok: true, ignored: true });
        const result = await recordCallStatus(deps.pool, telephony.name, event);
        if (result?.fetchRecording)
          await deps.jobs.add(
            "fetch_recording",
            { clinicId: result.clinicId, callId: result.callId },
            { jobKey: `recording:${result.callId}` },
          );
        if (result?.unanswered) {
          const missed = await handleUnansweredCall(
            deps.pool,
            telephony.name,
            event.providerCallId,
            event.status,
          );
          if (missed?.outboxId) await scheduleSend(deps.jobs, missed.clinicId, missed.outboxId);
        }
        return reply.send({ ok: true });
      },
    ],
  ];

  for (const [path, fn] of routes) {
    const options = { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } };
    app.get(path, options, handler(fn));
    app.post(path, options, handler(fn));
  }
}

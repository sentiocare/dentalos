import { DomainError, pgErrorCode } from "@dentalos/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/** Validates input with a Zod schema; failures become 400 responses listing the problem fields. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "invalid_input", "Some fields are missing or invalid", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DOMAIN_STATUS: Record<DomainError["code"], number> = {
  not_found: 404,
  invalid: 400,
  slot_taken: 409,
  hold_not_found: 409,
  needs_confirmation: 409,
  forbidden: 403,
  conflict: 409,
};

/** Maps domain, validation and known database errors to clear responses without leaking internals. */
export function errorResponse(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...error.details });
  }
  if (error instanceof DomainError) {
    return reply
      .code(DOMAIN_STATUS[error.code])
      .send({ error: error.code, message: error.message, ...error.details });
  }
  const pg = pgErrorCode(error);
  if (pg === "23P01")
    return reply.code(409).send({ error: "slot_taken", message: "That time is already booked" });
  if (pg === "23505") return reply.code(409).send({ error: "conflict", message: "This already exists" });
  if (pg === "23503")
    return reply.code(400).send({ error: "invalid_reference", message: "Linked record not found" });
  if (pg === "23514" || pg === "22P02" || pg === "22007" || pg === "22008") {
    return reply.code(400).send({ error: "invalid_input", message: "Some values are not valid" });
  }
  const status = (error as { statusCode?: number }).statusCode;
  if (status && status < 500) {
    return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
  }
  request.log.error({ err: error }, "request failed");
  return reply.code(500).send({ error: "internal_error", requestId: request.id });
}

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
export const instant = z.coerce.date();

import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { scrubText, scrubValue } from "./redact";

export type { Logger };

interface RequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  routeOptions?: { url?: unknown };
}

/**
 * pino runs `formatters.log` before serializers, so HTTP request/response objects are reduced here first.
 * Only the method, route and path are kept; query strings (which may carry phone numbers) are dropped.
 */
function reduceKnownObjects(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj };
  const req = obj.req as RequestLike | undefined;
  if (req && typeof req === "object") {
    out.req = {
      id: req.id,
      method: req.method,
      route: req.routeOptions?.url,
      // Named `url` so Fastify's own request serializer keeps it; the query string is removed.
      url: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
    };
  }
  const res = obj.res as { statusCode?: unknown } | undefined;
  if (res && typeof res === "object") out.res = { statusCode: res.statusCode };
  return out;
}

/**
 * The only logger allowed in backend code. Every object is deep-scrubbed and every message string has
 * phone numbers and emails masked, so a careless `log.info({ patient })` cannot leak PII.
 */
export function createLogger(
  options: { service: string; level?: string } & LoggerOptions,
  destination?: DestinationStream,
): Logger {
  const { service, level = "info", ...rest } = options;
  const config: LoggerOptions = {
    level,
    base: { service },
    ...rest,
    formatters: {
      log: (obj) => scrubValue(reduceKnownObjects(obj)) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === "string" ? scrubText(a) : a));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(config, destination) : pino(config);
}

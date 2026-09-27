import { scrubValue } from "@dentalos/shared";
import * as Sentry from "@sentry/node";

/** Error tracking with the same PII scrubbing as logs. Disabled when SENTRY_DSN is not set. */
export function initErrorTracking(options: { dsn?: string; environment: string; release: string }) {
  if (!options.dsn) return;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request?.data;
      delete event.request?.cookies;
      delete event.request?.query_string;
      if (event.user) event.user = { id: event.user.id };
      return scrubValue(event) as typeof event;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubValue(breadcrumb) as typeof breadcrumb;
    },
  });
}

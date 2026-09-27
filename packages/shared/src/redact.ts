/**
 * PII scrubbing for anything that leaves the database: logs, error trackers, analytics.
 * Patient data must never appear in application logs (Build Prompt §7.3).
 */

/** Object keys whose values are always removed from structured logs, at any depth. */
export const PII_KEYS = [
  "name",
  "patientName",
  "firstName",
  "lastName",
  "phone",
  "mobile",
  "from",
  "to",
  "email",
  "dob",
  "dateOfBirth",
  "address",
  "transcript",
  "body",
  "text",
  "message",
  "notes",
  "summary",
  "authorization",
  "cookie",
  "password",
  "otp",
  "token",
] as const;

const PHONE_RE = /(?:\+|\b)(?:91[\s-]?)?0?[6-9]\d{4}[\s-]?\d{5}\b|\b0\d{2,4}[\s-]?\d{6,8}\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function scrubText(text: string): string {
  return text.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

const PII_KEY_SET = new Set<string>(PII_KEYS.map((k) => k.toLowerCase()));

/** Deep-copies a value, replacing PII keys with "[redacted]" and scrubbing remaining strings. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return scrubText(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubText(value.message),
      stack: value.stack && scrubText(value.stack),
    };
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = PII_KEY_SET.has(key.toLowerCase()) ? "[redacted]" : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

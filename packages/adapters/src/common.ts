import { createHmac, timingSafeEqual } from "node:crypto";

export interface HealthStatus {
  ok: boolean;
  /** Short, PII-free explanation shown on the Sentio admin health panel. */
  detail?: string;
  latencyMs?: number;
}

/** Every provider adapter reports its name and health so per-clinic health checks can run uniformly. */
export interface ProviderBase {
  readonly name: string;
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Errors thrown by adapters. `retryable` tells the outbox and job queue whether to retry with backoff
 * (network errors, 5xx, rate limits) or give up and alert (bad number, rejected template, auth failure).
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface RawWebhook {
  headers: Record<string, string | undefined>;
  /** The exact bytes received. Signatures are computed over the raw body, never re-serialised JSON. */
  rawBody: string;
}

/** Providers that call us back verify signatures before anything is parsed. */
export interface WebhookReceiver<TEvent> {
  verifyWebhook(webhook: RawWebhook): boolean;
  /** Normalises a verified provider payload into our own event types. Each event carries a stable id for dedupe. */
  parseWebhook(webhook: RawWebhook): TEvent[];
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Usage reported by a provider, fed into the usage ledger for metering. */
export interface UsageReport {
  kind: "telephony_min" | "voice_min" | "wa_conversation" | "llm_tokens" | "sms";
  quantity: number;
  /** The provider's own cost in paise when the provider reports it; otherwise priced from the rate card. */
  providerCostPaise?: number;
}

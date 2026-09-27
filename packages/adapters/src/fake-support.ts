import { hmacSha256Hex, ProviderError, safeEqualHex, type HealthStatus, type RawWebhook } from "./common.js";

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

/**
 * Shared behaviour for all fake adapters: signed webhooks (so webhook verification paths are exercised in
 * tests), scripted failures and a toggleable health state.
 */
export class FakeSupport {
  private pendingFailures: ProviderError[] = [];
  healthy = true;

  constructor(
    readonly name: string,
    private readonly webhookSecret: string,
  ) {}

  /** The next adapter call will throw this error (retryable by default). */
  failNext(code = "fake_failure", retryable = true): void {
    this.pendingFailures.push(new ProviderError(this.name, code, `Scripted failure: ${code}`, retryable));
  }

  throwIfScripted(): void {
    const failure = this.pendingFailures.shift();
    if (failure) throw failure;
  }

  async healthCheck(): Promise<HealthStatus> {
    return this.healthy
      ? { ok: true, latencyMs: 0 }
      : { ok: false, detail: "fake provider marked unhealthy" };
  }

  signWebhook<T>(events: T[]): RawWebhook {
    const rawBody = JSON.stringify({ events });
    return {
      headers: { [FAKE_SIGNATURE_HEADER]: hmacSha256Hex(this.webhookSecret, rawBody) },
      rawBody,
    };
  }

  verifyWebhook(webhook: RawWebhook): boolean {
    const signature = webhook.headers[FAKE_SIGNATURE_HEADER];
    return !!signature && safeEqualHex(signature, hmacSha256Hex(this.webhookSecret, webhook.rawBody));
  }

  parseWebhook<T>(webhook: RawWebhook): T[] {
    if (!this.verifyWebhook(webhook)) {
      throw new ProviderError(this.name, "bad_signature", "Webhook signature invalid", false);
    }
    const parsed = JSON.parse(webhook.rawBody, (key, value: unknown) =>
      key === "at" && typeof value === "string" ? new Date(value) : value,
    ) as { events: T[] };
    return parsed.events;
  }
}

let counter = 0;
export function fakeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

import { ProviderError, type HealthStatus } from "../common";
import type { StorageProvider } from "./types";

/**
 * Supabase Storage (Mumbai), private bucket, server-side only with the service-role key. Docs:
 * https://supabase.com/docs/reference/api (Storage). Staff get short-lived signed URLs, never the bucket.
 */
export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  fetchImpl?: typeof fetch;
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase-storage";
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: SupabaseStorageConfig) {
    this.base = `${config.url.replace(/\/$/, "")}/storage/v1`;
    this.fetch = config.fetchImpl ?? fetch;
  }

  private path(key: string) {
    return key.split("/").map(encodeURIComponent).join("/");
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.serviceRoleKey}`,
          apikey: this.config.serviceRoleKey,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, "network", `Storage unreachable: ${(error as Error).name}`, true);
    }
  }

  private fail(res: Response, what: string): never {
    throw new ProviderError(
      this.name,
      String(res.status),
      `Storage ${what} failed (${res.status})`,
      res.status >= 500 || res.status === 429,
    );
  }

  async put(input: { key: string; bytes: Uint8Array; contentType: string }) {
    const res = await this.call(`${this.base}/object/${this.config.bucket}/${this.path(input.key)}`, {
      method: "POST",
      headers: { "content-type": input.contentType, "x-upsert": "true" },
      body: input.bytes,
    });
    if (!res.ok) this.fail(res, "upload");
  }

  async get(key: string) {
    const res = await this.call(`${this.base}/object/${this.config.bucket}/${this.path(key)}`, {
      method: "GET",
    });
    // Supabase answers 400 "Object not found" as well as 404.
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) this.fail(res, "download");
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async signedUrl(key: string, ttlSec: number) {
    const res = await this.call(`${this.base}/object/sign/${this.config.bucket}/${this.path(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: ttlSec }),
    });
    if (!res.ok) this.fail(res, "signing");
    const json = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = json.signedURL ?? json.signedUrl;
    if (!signed) throw new ProviderError(this.name, "no_url", "Storage returned no signed URL", true);
    return signed.startsWith("http") ? signed : `${this.base}${signed.startsWith("/") ? "" : "/"}${signed}`;
  }

  async delete(key: string) {
    const res = await this.call(`${this.base}/object/${this.config.bucket}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) this.fail(res, "delete");
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = Date.now();
    const res = await this.call(`${this.base}/bucket/${this.config.bucket}`, { method: "GET" }).catch(
      () => null,
    );
    return res?.ok
      ? { ok: true, latencyMs: Date.now() - started }
      : { ok: false, detail: res ? `bucket check failed (${res.status})` : "storage unreachable" };
  }
}

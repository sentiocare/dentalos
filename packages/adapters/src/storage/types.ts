import type { ProviderBase } from "../common";

/** Object storage in an Indian region (Supabase Storage, Mumbai). All buckets are private. */
export interface StorageProvider extends ProviderBase {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Short-lived URL, e.g. to hand a PDF to WhatsApp or show a recording to staff. */
  signedUrl(key: string, ttlSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}

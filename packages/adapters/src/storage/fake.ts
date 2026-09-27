import { FakeSupport } from "../fake-support";
import type { StorageProvider } from "./types";

export class FakeStorageProvider implements StorageProvider {
  readonly name = "fake-storage";
  readonly support = new FakeSupport(this.name, "unused");
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(input: { key: string; bytes: Uint8Array; contentType: string }) {
    this.support.throwIfScripted();
    this.objects.set(input.key, { bytes: input.bytes, contentType: input.contentType });
  }

  async get(key: string) {
    this.support.throwIfScripted();
    return this.objects.get(key) ?? null;
  }

  async signedUrl(key: string, ttlSec: number) {
    if (!this.objects.has(key)) throw new Error(`No object at ${key}`);
    return `https://storage.fake.local/${encodeURIComponent(key)}?expires_in=${ttlSec}`;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

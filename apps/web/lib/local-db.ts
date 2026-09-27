import Dexie, { type Table } from "dexie";

/**
 * On-device storage so the front desk keeps working when the 4G drops (Build Prompt §5.15):
 * today's schedule and clinic configuration are cached, and changes made offline wait in the outbox.
 * Everything is per clinic and cleared on sign-out.
 */
export interface CachedValue {
  key: string;
  value: unknown;
  savedAt: number;
}

export interface OutboxEntry {
  seq?: number;
  clinicId: string;
  createdAt: number;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Short human description shown in the pending-changes list, e.g. "Check in Ramesh Kumar". */
  label: string;
  status: "pending" | "failed";
  error?: string;
}

class LocalDb extends Dexie {
  cache!: Table<CachedValue, string>;
  outbox!: Table<OutboxEntry, number>;

  constructor() {
    super("sentio-dental");
    this.version(1).stores({ cache: "key", outbox: "++seq, clinicId, status" });
  }
}

let db: LocalDb | null = null;

/** Null when IndexedDB is unavailable (private mode on some phones): the app still works online. */
export function localDb(): LocalDb | null {
  if (typeof indexedDB === "undefined") return null;
  db ??= new LocalDb();
  return db;
}

export async function readCache<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  try {
    const row = await localDb()?.cache.get(key);
    return row ? { value: row.value as T, savedAt: row.savedAt } : null;
  } catch {
    return null;
  }
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await localDb()?.cache.put({ key, value, savedAt: Date.now() });
  } catch {
    // Storage full or blocked: caching is best-effort.
  }
}

export async function clearLocalData(): Promise<void> {
  try {
    await localDb()?.delete();
  } catch {
    // ignore
  }
  db = null;
}

"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, OfflineError } from "./api";
import { localDb, type OutboxEntry } from "./local-db";
import { useSession } from "./session";

/**
 * Changes made while offline are stored on the phone and sent in order when the connection returns.
 * Requests carry idempotency keys where the server supports them, so a replay after a lost response never
 * creates a duplicate. A change the server refuses (e.g. the slot was taken meanwhile) stays visible as
 * "failed" until someone looks at it.
 */
interface OutboxState {
  online: boolean;
  pending: number;
  failed: OutboxEntry[];
  /** Sends now if online; otherwise queues. Returns the server response, or null when queued. */
  send: <T>(entry: Omit<OutboxEntry, "clinicId" | "createdAt" | "status">) => Promise<T | null>;
  flush: () => Promise<void>;
  discard: (seq: number) => Promise<void>;
}

const Ctx = createContext<OutboxState | null>(null);

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function OutboxProvider({ children, onFlushed }: { children: ReactNode; onFlushed?: () => void }) {
  const { api, clinic } = useSession();
  const online = useOnline();
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<OutboxEntry[]>([]);
  const flushing = useRef(false);

  const refreshCounts = useCallback(async () => {
    const db = localDb();
    if (!db || !clinic) return;
    const all = await db.outbox.where("clinicId").equals(clinic.id).toArray();
    setPending(all.filter((e) => e.status === "pending").length);
    setFailed(all.filter((e) => e.status === "failed"));
  }, [clinic]);

  const flush = useCallback(async () => {
    const db = localDb();
    if (!db || !clinic || flushing.current) return;
    flushing.current = true;
    let sentAny = false;
    try {
      const queue = await db.outbox.where("clinicId").equals(clinic.id).sortBy("seq");
      for (const entry of queue.filter((e) => e.status === "pending")) {
        try {
          await api(entry.path, { method: entry.method, body: entry.body });
          await db.outbox.delete(entry.seq!);
          sentAny = true;
        } catch (error) {
          if (error instanceof OfflineError) break;
          const message = error instanceof ApiError ? error.message : "Could not send";
          await db.outbox.update(entry.seq!, { status: "failed", error: message });
        }
      }
    } finally {
      flushing.current = false;
      await refreshCounts();
      if (sentAny) {
        onFlushed?.();
        // Screens reload their data once queued changes have reached the server.
        window.dispatchEvent(new Event("sentio:synced"));
      }
    }
  }, [api, clinic, onFlushed, refreshCounts]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  useEffect(() => {
    if (online) void flush();
    const timer = setInterval(() => {
      if (navigator.onLine) void flush();
    }, 30_000);
    return () => clearInterval(timer);
  }, [online, flush]);

  const send = useCallback(
    async <T,>(entry: Omit<OutboxEntry, "clinicId" | "createdAt" | "status">): Promise<T | null> => {
      try {
        return await api<T>(entry.path, { method: entry.method, body: entry.body });
      } catch (error) {
        const db = localDb();
        if (!(error instanceof OfflineError) || !db || !clinic) throw error;
        await db.outbox.add({ ...entry, clinicId: clinic.id, createdAt: Date.now(), status: "pending" });
        await refreshCounts();
        return null;
      }
    },
    [api, clinic, refreshCounts],
  );

  const discard = useCallback(
    async (seq: number) => {
      await localDb()?.outbox.delete(seq);
      await refreshCounts();
    },
    [refreshCounts],
  );

  return <Ctx.Provider value={{ online, pending, failed, send, flush, discard }}>{children}</Ctx.Provider>;
}

export function useOutbox(): OutboxState {
  const value = useContext(Ctx);
  if (!value) throw new Error("OutboxProvider missing");
  return value;
}

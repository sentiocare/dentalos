"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OfflineError } from "./api";
import { readCache, writeCache } from "./local-db";
import { useSession } from "./session";
import type { Appointment, ClinicConfig } from "./types";

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** When the data came from the phone's cache because the network was down: when it was saved. */
  cachedAt: number | null;
  reload: () => Promise<void>;
  setData: (update: (current: T | null) => T | null) => void;
}

/** Loads from the API and remembers the result on the phone; falls back to the copy when offline. */
export function useCachedQuery<T>(path: string | null, cacheKey: string | null): Loadable<T> {
  const { api, status } = useSession();
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!path || !cacheKey || status !== "ready") return;
    const id = ++request.current;
    setLoading(true);
    const cached = await readCache<T>(cacheKey);
    if (cached && id === request.current) setDataState(cached.value);
    try {
      const fresh = await api<T>(path);
      if (id !== request.current) return;
      setDataState(fresh);
      setCachedAt(null);
      setError(null);
      await writeCache(cacheKey, fresh);
    } catch (e) {
      if (id !== request.current) return;
      if (e instanceof OfflineError && cached) setCachedAt(cached.savedAt);
      else setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [api, cacheKey, path, status]);

  useEffect(() => {
    void load();
    const onSynced = () => void load();
    window.addEventListener("sentio:synced", onSynced);
    return () => window.removeEventListener("sentio:synced", onSynced);
  }, [load]);

  const setData = useCallback(
    (update: (current: T | null) => T | null) => {
      setDataState((current) => {
        const next = update(current);
        if (cacheKey && next) void writeCache(cacheKey, next);
        return next;
      });
    },
    [cacheKey],
  );

  return { data, loading, error, cachedAt, reload: load, setData };
}

export function useClinicConfig(): Loadable<ClinicConfig> {
  const { clinic } = useSession();
  return useCachedQuery<ClinicConfig>(clinic ? "/v1/config" : null, clinic ? `config:${clinic.id}` : null);
}

export function useAppointments(
  range: { from: string; to: string; key: string } | null,
): Loadable<Appointment[]> {
  const { clinic } = useSession();
  const path = range
    ? `/v1/appointments?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
    : null;
  return useCachedQuery<Appointment[]>(path, clinic && range ? `appts:${clinic.id}:${range.key}` : null);
}

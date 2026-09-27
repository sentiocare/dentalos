"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApiClient, OfflineError, type ApiFn } from "./api";
import { getAuthDriver, type AuthDriver } from "./auth-driver";
import { clearLocalData, readCache, writeCache } from "./local-db";
import { useRuntimeConfig } from "./runtime-config";

export interface ClinicSummary {
  id: string;
  name: string;
  role: "owner" | "doctor" | "receptionist" | "assistant";
  displayName: string;
}

interface MeResponse {
  user: { id: string; phone: string | null; name: string | null; uiLanguage: "en" | "hi" };
  clinics: ClinicSummary[];
}

interface Session {
  status: "loading" | "signed_out" | "no_clinic" | "ready";
  driver: AuthDriver;
  api: ApiFn;
  me: MeResponse | null;
  clinic: ClinicSummary | null;
  permissions: Set<string>;
  can: (permission: string) => boolean;
  selectClinic: (id: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);
const CLINIC_KEY = "sentio.clinicId";

function savedClinicId(): string | null {
  try {
    return localStorage.getItem(CLINIC_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const config = useRuntimeConfig();
  const router = useRouter();
  const driver = useMemo(() => getAuthDriver(config), [config]);
  const clinicIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Session["status"]>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  const signOut = useCallback(async () => {
    await driver.signOut();
    await clearLocalData();
    try {
      localStorage.removeItem(CLINIC_KEY);
    } catch {
      // ignore
    }
    setMe(null);
    setStatus("signed_out");
    router.replace("/login");
  }, [driver, router]);

  const api = useMemo(
    () =>
      createApiClient({
        apiUrl: config.apiUrl,
        getToken: () => driver.getToken(),
        clinicId: () => clinicIdRef.current,
        onUnauthorized: () => void signOut(),
      }),
    [config.apiUrl, driver, signOut],
  );

  const refresh = useCallback(async () => {
    const token = await driver.getToken();
    if (!token) {
      setStatus("signed_out");
      return;
    }
    let data: MeResponse;
    let perms: string[];
    try {
      data = await api<MeResponse>("/v1/me");
      await writeCache("me", data);
    } catch (error) {
      // Offline at start-up: continue with what the phone remembers.
      const cached = error instanceof OfflineError ? await readCache<MeResponse>("me") : null;
      if (!cached) {
        setStatus("signed_out");
        return;
      }
      data = cached.value;
    }
    setMe(data);
    const chosen =
      data.clinics.find((c) => c.id === (clinicIdRef.current ?? savedClinicId())) ?? data.clinics[0];
    if (!chosen) {
      setStatus("no_clinic");
      return;
    }
    clinicIdRef.current = chosen.id;
    setClinicId(chosen.id);
    try {
      perms = (await api<{ permissions: string[] }>("/v1/me/permissions")).permissions;
      await writeCache(`perms:${chosen.id}`, perms);
    } catch {
      perms = (await readCache<string[]>(`perms:${chosen.id}`))?.value ?? [];
    }
    setPermissions(new Set(perms));
    setStatus("ready");
  }, [api, driver]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectClinic = useCallback(
    (id: string) => {
      clinicIdRef.current = id;
      try {
        localStorage.setItem(CLINIC_KEY, id);
      } catch {
        // ignore
      }
      void refresh();
    },
    [refresh],
  );

  const clinic = me?.clinics.find((c) => c.id === clinicId) ?? null;
  const value: Session = {
    status,
    driver,
    api,
    me,
    clinic,
    permissions,
    can: (p) => permissions.has(p),
    selectClinic,
    refresh,
    signOut,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider missing");
  return value;
}

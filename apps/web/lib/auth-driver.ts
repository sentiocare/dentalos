import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "./runtime-config";

/** How staff sign in: Supabase phone OTP in real deployments, a code-free login in local development. */
export interface AuthDriver {
  kind: "supabase" | "dev";
  requestOtp(phoneE164: string): Promise<void>;
  verifyOtp(phoneE164: string, code: string): Promise<void>;
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
}

const DEV_TOKEN_KEY = "sentio.devToken";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function devDriver(apiUrl: string): AuthDriver {
  return {
    kind: "dev",
    async requestOtp() {},
    async verifyOtp(phone) {
      const res = await fetch(`${apiUrl}/v1/dev/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) throw new Error("Dev login failed");
      const { token } = (await res.json()) as { token: string };
      storage()?.setItem(DEV_TOKEN_KEY, token);
    },
    async getToken() {
      return storage()?.getItem(DEV_TOKEN_KEY) ?? null;
    },
    async signOut() {
      storage()?.removeItem(DEV_TOKEN_KEY);
    },
  };
}

function supabaseDriver(client: SupabaseClient): AuthDriver {
  return {
    kind: "supabase",
    async requestOtp(phone) {
      const { error } = await client.auth.signInWithOtp({ phone, options: { channel: "sms" } });
      if (error) throw error;
    },
    async verifyOtp(phone, code) {
      const { error } = await client.auth.verifyOtp({ phone, token: code, type: "sms" });
      if (error) throw error;
    },
    async getToken() {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },
    async signOut() {
      await client.auth.signOut();
    },
  };
}

let cached: AuthDriver | null = null;

export function getAuthDriver(config: RuntimeConfig): AuthDriver {
  if (cached) return cached;
  if (config.devLogin || !config.supabaseUrl || !config.supabaseAnonKey) {
    cached = devDriver(config.apiUrl);
  } else {
    cached = supabaseDriver(
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "sentio.auth" },
      }),
    );
  }
  return cached;
}

"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Settings read on the server at request time (not baked in at build time), so the same image works for
 * staging and production.
 */
export interface RuntimeConfig {
  apiUrl: string;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  devLogin: boolean;
}

const Ctx = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({ value, children }: { value: RuntimeConfig; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const value = useContext(Ctx);
  if (!value) throw new Error("RuntimeConfigProvider missing");
  return value;
}

import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ServiceWorker } from "../components/service-worker";
import { ToastProvider } from "../components/ui";
import { RuntimeConfigProvider, type RuntimeConfig } from "../lib/runtime-config";
import { SessionProvider } from "../lib/session";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    title: t("name"),
    description: t("tagline"),
    applicationName: "Sentio Dental OS",
    appleWebApp: { capable: true, title: "Sentio", statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

function runtimeConfig(): RuntimeConfig {
  return {
    apiUrl: (process.env.API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    devLogin: process.env.DEV_LOGIN === "on",
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body className="min-h-dvh bg-slate-50">
        <NextIntlClientProvider>
          <RuntimeConfigProvider value={runtimeConfig()}>
            <ToastProvider>
              <SessionProvider>{children}</SessionProvider>
            </ToastProvider>
          </RuntimeConfigProvider>
        </NextIntlClientProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { useOutbox } from "../lib/outbox";
import { useSession } from "../lib/session";
import { Button, Spinner } from "./ui";

const NAV = [
  { href: "/today", key: "today", icon: "◉" },
  { href: "/calendar", key: "calendar", icon: "▦" },
  { href: "/patients", key: "patients", icon: "☺" },
  { href: "/more", key: "more", icon: "☰" },
] as const;

function SyncBanner() {
  const t = useTranslations("common");
  const { online, pending, failed, discard } = useOutbox();
  if (online && pending === 0 && failed.length === 0) return null;
  return (
    <div className="space-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      {!online ? <p className="font-medium">● {t("offline")}</p> : null}
      {pending > 0 ? <p>{t("pending", { count: pending })}</p> : null}
      {failed.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-red-700">{t("failed", { count: failed.length })}</summary>
          <ul className="mt-1 space-y-1">
            {failed.map((f) => (
              <li key={f.seq} className="flex items-center justify-between gap-2">
                <span>
                  {f.label}: <span className="text-red-700">{f.error}</span>
                </span>
                <button className="underline" onClick={() => void discard(f.seq!)}>
                  {t("discard")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Signed-in frame: header, offline/sync banner, bottom navigation on phones and a side rail on desktop. */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const tl = useTranslations("login");
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    if (session.status === "signed_out") router.replace("/login");
  }, [session.status, router]);

  if (session.status === "loading" || session.status === "signed_out") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-slate-500">
        <Spinner />
      </div>
    );
  }
  if (session.status === "no_clinic") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
        <p className="text-slate-700">{tl("notAdded")}</p>
        <Button variant="secondary" onClick={() => void session.signOut()}>
          {t("signOut")}
        </Button>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r border-slate-200 p-3 md:flex">
        <p className="px-3 py-2 text-sm font-semibold text-brand-700">{session.clinic?.name}</p>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-xl px-3 py-2 text-sm ${pathname.startsWith(item.href) ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50"}`}
          >
            {t(item.key)}
          </Link>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur md:hidden">
          <span className="truncate text-sm font-semibold text-brand-700">{session.clinic?.name}</span>
          <span className="text-xs text-slate-500">{session.clinic?.displayName}</span>
        </header>
        <SyncBanner />
        <main className="flex-1 pb-20 md:pb-6">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 py-2 text-xs ${active ? "font-medium text-brand-700" : "text-slate-500"}`}
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              {t(item.key)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

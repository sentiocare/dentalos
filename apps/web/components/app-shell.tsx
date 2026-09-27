"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { useOutbox } from "../lib/outbox";
import { useSession } from "../lib/session";
import { GlobalSearch } from "./global-search";
import { Button, Spinner } from "./ui";

const NAV = [
  { href: "/today", key: "today", icon: "◉" },
  { href: "/calendar", key: "calendar", icon: "▦" },
  { href: "/inbox", key: "inbox", icon: "✉" },
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

/** For the owner: the usage wallet is low or paused (checked when the app opens, and every 10 minutes). */
function WalletBanner() {
  const t = useTranslations("wallet");
  const { api, can, clinic } = useSession();
  const [state, setState] = useState<string | null>(null);
  const allowed = can("settings.manage");
  useEffect(() => {
    if (!allowed || !clinic) return;
    const check = () =>
      void api<{ enforced: boolean; state: string }>("/v1/wallet")
        .then((w) => setState(w.enforced && w.state !== "active" ? w.state : null))
        .catch(() => {});
    check();
    const timer = setInterval(check, 10 * 60_000);
    return () => clearInterval(timer);
  }, [api, allowed, clinic]);
  if (!state) return null;
  return (
    <Link
      href="/wallet"
      data-testid="wallet-banner"
      className={`block border-b px-4 py-2 text-sm ${state === "low" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900"}`}
    >
      {t(`banner.${state}`)} <span className="underline">{t("addMoney")}</span>
    </Link>
  );
}

interface Counts {
  tasks: number;
  critical: number;
  unread: number;
  leads: number;
}

/** What needs someone now, for the menu badges (every 30 seconds). */
function useCounts() {
  const { api, can, clinic } = useSession();
  const [counts, setCounts] = useState<Counts | null>(null);
  const allowed = can("appointments.read");
  useEffect(() => {
    if (!allowed || !clinic) return;
    const load = () =>
      void api<Counts>("/v1/desk/counts")
        .then(setCounts)
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [api, allowed, clinic]);
  return counts;
}

function Badge({ n, urgent, label }: { n: number | undefined; urgent?: boolean; label: string }) {
  if (!n) return null;
  return (
    <span
      aria-label={label}
      className={`ml-auto min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold text-white ${urgent ? "bg-red-600" : "bg-brand-600"}`}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/**
 * Signed-in frame. Phones: a header and bottom navigation. Desk computers: a side menu with everything the
 * desk uses in a day (with counts of what's waiting), and a top bar with patient search and quick actions.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const tl = useTranslations("login");
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const counts = useCounts();
  const [searching, setSearching] = useState(false);

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

  const can = session.can;
  const groups: {
    title?: string;
    items: { href: string; key: string; show: boolean; badge?: ReactNode }[];
  }[] = [
    {
      items: [
        { href: "/today", key: "today", show: true },
        { href: "/calendar", key: "calendar", show: true },
        {
          href: "/inbox",
          key: "inbox",
          show: can("patients.read"),
          badge: <Badge n={counts?.unread} label={t("unread", { n: counts?.unread ?? 0 })} />,
        },
        {
          href: "/tasks",
          key: "tasks",
          show: can("appointments.read"),
          badge: (
            <Badge
              n={counts?.tasks}
              urgent={!!counts?.critical}
              label={t("waiting", { n: counts?.tasks ?? 0 })}
            />
          ),
        },
        { href: "/patients", key: "patients", show: can("patients.read") },
        { href: "/calls", key: "calls", show: can("patients.read") },
        {
          href: "/leads",
          key: "leads",
          show: can("patients.read"),
          badge: <Badge n={counts?.leads} label={t("toCall", { n: counts?.leads ?? 0 })} />,
        },
      ],
    },
    {
      title: t("groupClinic"),
      items: [
        { href: "/money", key: "money", show: can("reports.revenue") },
        { href: "/reports", key: "reports", show: can("reports.revenue") },
        { href: "/treatments", key: "treatments", show: can("patients.read") },
        { href: "/followups", key: "followups", show: can("appointments.read") },
        { href: "/campaigns", key: "campaigns", show: can("settings.manage") },
      ],
    },
    {
      title: t("groupSetup"),
      items: [
        { href: "/setup", key: "setup", show: can("settings.manage") },
        { href: "/settings", key: "settings", show: true },
        { href: "/more", key: "more", show: true },
      ],
    },
  ];
  const writes = can("appointments.write");

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav
        aria-label={t("menu")}
        className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-3 md:flex"
      >
        <p className="px-3 pt-1 pb-3 text-sm font-semibold text-brand-700">{session.clinic?.name}</p>
        {groups.map((g, i) => {
          const items = g.items.filter((x) => x.show);
          if (!items.length) return null;
          return (
            <div key={i} className="mb-2 space-y-0.5">
              {g.title ? (
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                  {g.title}
                </p>
              ) : null}
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${pathname.startsWith(item.href) ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50"}`}
                >
                  {t(item.key)}
                  {item.badge}
                </Link>
              ))}
            </div>
          );
        })}
        <div className="mt-auto border-t border-slate-100 px-3 pt-3 text-xs text-slate-500">
          <p className="truncate font-medium text-slate-700">{session.clinic?.displayName}</p>
          <button className="mt-1 underline" onClick={() => void session.signOut()}>
            {t("signOut")}
          </button>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 hidden items-center gap-3 border-b border-slate-200 bg-white/95 px-6 py-2 backdrop-blur md:flex">
          <div className="max-w-md flex-1">
            <GlobalSearch />
          </div>
          {writes ? (
            <div className="ml-auto flex gap-2">
              <Link
                href="/today?walkin=1"
                className="inline-flex min-h-10 items-center rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                + {t("walkIn")}
              </Link>
              <Link
                href="/today?book=1"
                className="inline-flex min-h-10 items-center rounded-xl bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700"
              >
                + {t("appointment")}
              </Link>
            </div>
          ) : null}
        </header>
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur md:hidden">
          {searching ? (
            <GlobalSearch autoFocus onDone={() => setSearching(false)} />
          ) : (
            <>
              <span className="min-w-0 truncate text-sm font-semibold text-brand-700">
                {session.clinic?.name}
              </span>
              {can("patients.read") ? (
                <button
                  aria-label={t("search")}
                  onClick={() => setSearching(true)}
                  className="shrink-0 rounded-lg px-2 text-lg text-slate-600 hover:bg-slate-100"
                >
                  <span aria-hidden>⌕</span>
                </button>
              ) : null}
            </>
          )}
        </header>
        <SyncBanner />
        <WalletBanner />
        <main className="flex-1 pb-20 md:pb-6">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          const n = item.key === "inbox" ? counts?.unread : item.key === "more" ? counts?.tasks : undefined;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex flex-col items-center gap-0.5 py-2 text-xs ${active ? "font-medium text-brand-700" : "text-slate-500"}`}
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              {t(item.key)}
              {n ? (
                <span
                  aria-hidden
                  className={`absolute top-1 left-1/2 ml-2 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold text-white ${item.key === "more" && counts?.critical ? "bg-red-600" : "bg-brand-600"}`}
                >
                  {n > 99 ? "99+" : n}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

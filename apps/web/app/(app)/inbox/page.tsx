"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { EmptyState, Spinner } from "../../../components/ui";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";

interface Row {
  id: string;
  phone: string;
  mode: "bot" | "human";
  last_message_at: string;
  last_preview: string | null;
  unread_count: number;
  patient_name: string | null;
  open_tasks: number;
  critical: string | null;
}

const FILTERS = ["all", "unread", "tasks", "human"] as const;

export default function InboxPage() {
  const t = useTranslations("inbox");
  const locale = useLocale();
  const { api } = useSession();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Row[]>(`/v1/inbox?filter=${filter}`)
        .then((r) => alive && setRows(r))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, filter]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="shrink-0 rounded-full border border-slate-300 px-3 py-1.5 text-sm aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-pressed:text-brand-700"
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>
      {!rows ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/inbox/${r.id}`}
                className={`flex items-start gap-3 px-4 py-3 hover:bg-slate-50 ${r.critical ? "bg-red-50" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`truncate ${r.unread_count ? "font-semibold" : "font-medium"}`}>
                      {r.patient_name ?? displayPhone(r.phone)}
                    </p>
                    <span className="shrink-0 text-xs text-slate-500">{time(r.last_message_at)}</span>
                  </div>
                  <p className="truncate text-sm text-slate-600">{r.last_preview}</p>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                    {r.critical ? (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-white">{t("emergency")}</span>
                    ) : null}
                    {r.mode === "human" ? (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-800">
                        {t("staff")}
                      </span>
                    ) : null}
                    {r.open_tasks && !r.critical ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
                        {t("filters.tasks")}
                      </span>
                    ) : null}
                  </div>
                </div>
                {r.unread_count ? (
                  <span className="mt-1 rounded-full bg-brand-600 px-2 text-xs text-white">
                    {r.unread_count}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

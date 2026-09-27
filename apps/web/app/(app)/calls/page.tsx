"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { EmptyState, Spinner } from "../../../components/ui";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";

interface CallRow {
  id: string;
  started_at: string;
  from_phone: string | null;
  route: string | null;
  outcome: string | null;
  duration_sec: number | null;
  summary: string | null;
  is_test: boolean;
  test_result: "pass" | "fail" | null;
  patient_name: string | null;
}

const FILTERS = ["all", "assistant", "forwarded", "emergency", "test"] as const;

const OUTCOME_STYLE: Record<string, string> = {
  booked: "bg-emerald-100 text-emerald-800",
  rescheduled: "bg-emerald-100 text-emerald-800",
  emergency: "bg-red-600 text-white",
  transfer_failed: "bg-amber-100 text-amber-800",
  callback: "bg-amber-100 text-amber-800",
  error: "bg-red-100 text-red-800",
};

export default function CallsPage() {
  const t = useTranslations("calls");
  const locale = useLocale();
  const { api } = useSession();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [progress, setProgress] = useState<{ passed: number; failed: number; target: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api<CallRow[]>(`/v1/calls?filter=${filter}`)
        .then((r) => alive && setRows(r))
        .catch(() => {});
      void api<{ passed: number; failed: number; target: number }>("/v1/calls/test-summary")
        .then((p) => alive && setProgress(p))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, filter]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      {progress && (progress.passed || progress.failed) ? (
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm">{t("testProgress", progress)}</p>
      ) : null}
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
              <Link href={`/calls/${r.id}`} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium">
                    {r.patient_name ?? (r.from_phone ? displayPhone(r.from_phone) : t("unknownCaller"))}
                  </p>
                  <span className="shrink-0 text-xs text-slate-500">{time(r.started_at)}</span>
                </div>
                {r.summary ? <p className="truncate text-sm text-slate-600">{r.summary}</p> : null}
                <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                  {r.outcome ? (
                    <span
                      className={`rounded-full px-2 py-0.5 ${OUTCOME_STYLE[r.outcome] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {t(`outcomes.${r.outcome}`)}
                    </span>
                  ) : null}
                  {r.route && r.route !== "assistant" ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                      {t(`routes.${r.route}`)}
                    </span>
                  ) : null}
                  {r.duration_sec ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                      {t("duration", { sec: r.duration_sec })}
                    </span>
                  ) : null}
                  {r.test_result ? (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-800">
                      {t(r.test_result)}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { EmptyState, Spinner } from "../../../components/ui";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";
import { formatRupees } from "../../../lib/time";

interface Row {
  planId: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  title: string;
  sittingsLeft: number;
  remainingPaise: number | null;
  nextProcedure: string | null;
  nextExpectedFrom: string | null;
  nextExpectedTo: string | null;
  overdueDays: number;
  nextBooked: boolean;
}

interface Result {
  rows: Row[];
  totals: { plans: number; remainingPaise: number | null; overduePlans: number; overduePaise: number | null };
}

/** Build Prompt §5.4: every unfinished treatment, what it is worth, overdue first. */
export default function IncompleteTreatmentsPage() {
  const t = useTranslations("treatments");
  const locale = useLocale();
  const { api } = useSession();
  const [data, setData] = useState<Result | null>(null);
  useEffect(() => {
    void api<Result>("/v1/incomplete-treatments")
      .then(setData)
      .catch(() => {});
  }, [api]);

  if (!data) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const showMoney = data.totals.remainingPaise !== null;
  return (
    <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="grid grid-cols-2 gap-2" data-testid="treatment-totals">
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-xs text-slate-500">{t("remaining")}</p>
          <p className="text-lg font-semibold">
            {data.totals.plans} {t("plans").toLowerCase()}
            {showMoney ? ` · ${formatRupees(data.totals.remainingPaise, locale)}` : ""}
          </p>
        </div>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">{t("overdue")}</p>
          <p className="text-lg font-semibold text-red-800">
            {data.totals.overduePlans}
            {showMoney ? ` · ${formatRupees(data.totals.overduePaise, locale)}` : ""}
          </p>
        </div>
      </div>
      {data.rows.length === 0 ? <EmptyState>{t("empty")}</EmptyState> : null}
      <ul className="space-y-2">
        {data.rows.map((r) => (
          <li
            key={r.planId}
            className={`rounded-2xl border p-3 ${r.overdueDays ? "border-red-200 bg-white" : "border-slate-200 bg-white"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/patients/${r.patientId}`} className="font-medium hover:underline">
                  {r.patientName}
                </Link>
                <p className="text-sm text-slate-600">
                  {r.title} · {t("sittingsLeft", { count: r.sittingsLeft })}
                </p>
                {r.nextProcedure ? (
                  <p className="text-xs text-slate-500">
                    {r.nextBooked
                      ? t("booked")
                      : t("next", {
                          procedure: r.nextProcedure,
                          window: `${r.nextExpectedFrom?.slice(5) ?? ""} – ${r.nextExpectedTo?.slice(5) ?? ""}`,
                        })}
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                {r.remainingPaise !== null ? (
                  <p className="font-semibold">{formatRupees(r.remainingPaise, locale)}</p>
                ) : null}
                {r.overdueDays ? (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-800">
                    {t("overdueDays", { days: r.overdueDays })}
                  </span>
                ) : null}
              </div>
            </div>
            {r.phone ? (
              <a href={`tel:${r.phone}`} className="mt-2 inline-block text-sm text-brand-700 underline">
                📞 {t("call")} {displayPhone(r.phone)}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

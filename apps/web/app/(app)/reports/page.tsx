"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { Card, Spinner } from "../../../components/ui";
import { useClinicConfig } from "../../../lib/data";
import { useSession } from "../../../lib/session";
import { formatRupees, todayIn } from "../../../lib/time";

interface Report {
  start: string;
  end: string;
  visits: { done: number; no_shows: number; cancelled: number; scheduled: number };
  bookings: { total: number; whatsapp: number; voice: number };
  calls: { total: number; byAssistant: number; emergencies: number };
  chats: number;
  collectedPaise: number;
  duesPaise: number;
  leads: { new: number; booked: number; won: number };
  reviews: { asked: number; good: number; bad: number };
  recovered: {
    totalPaise: number;
    byKind: Record<string, number>;
    payments: {
      paymentId: string;
      patientId: string;
      patient: string;
      amountPaise: number;
      paidAt: string;
      kind: string;
      followupAt: string;
    }[];
  };
  tomorrow: { date: string; booked: number; unconfirmed: number } | null;
}
type Period = "day" | "week" | "month";

export default function ReportsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Reports />
    </Suspense>
  );
}

/** The owner's report (PLAN Phase 6): the day, week or month in numbers, and every recovered rupee. */
function Reports() {
  const t = useTranslations("reports");
  const locale = useLocale();
  const { api, can } = useSession();
  const config = useClinicConfig();
  const params = useSearchParams();
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";
  const [period, setPeriod] = useState<Period>("day");
  const [date, setDate] = useState(params.get("date") ?? todayIn(tz));
  const [r, setR] = useState<Report | null>(null);
  const [nightly, setNightly] = useState<boolean | null>(null);
  const rupees = (p: number) => formatRupees(p, locale);
  const manage = can("settings.manage");

  useEffect(() => {
    setR(null);
    void api<Report>(`/v1/reports?period=${period}&date=${date}`)
      .then(setR)
      .catch(() => {});
  }, [api, period, date]);
  useEffect(() => {
    if (manage)
      void api<{ nightly: boolean }>("/v1/reports/settings")
        .then((s) => setNightly(s.nightly))
        .catch(() => {});
  }, [api, manage]);

  const tile = (label: string, value: string | number, sub?: string) => (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {sub ? <p className="text-xs text-slate-500">{sub}</p> : null}
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {(["day", "week", "month"] as const).map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={period === p}
            onClick={() => setPeriod(p)}
            className={`rounded-full px-3 py-1 text-sm ${period === p ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"}`}
          >
            {t(`periods.${p}`)}
          </button>
        ))}
        <input
          type="date"
          aria-label={t("date")}
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="rounded-xl border border-slate-300 px-2 py-1 text-sm"
        />
      </div>

      {!r ? (
        <Spinner />
      ) : (
        <>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4" data-testid="recovered">
            <p className="text-sm text-emerald-900">{t("recovered")}</p>
            <p className="text-2xl font-semibold text-emerald-900">{rupees(r.recovered.totalPaise)}</p>
            <p className="mt-1 text-xs text-emerald-900">{t("recoveredHow")}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="report-tiles">
            {tile(t("seen"), r.visits.done, t("noShows", { n: r.visits.no_shows }))}
            {tile(
              t("newBookings"),
              r.bookings.total,
              t("byAssistant", { n: r.bookings.whatsapp + r.bookings.voice }),
            )}
            {tile(t("calls"), r.calls.total, t("answeredByAssistant", { n: r.calls.byAssistant }))}
            {tile(t("chats"), r.chats)}
            {tile(t("collected"), rupees(r.collectedPaise), t("dues", { amount: rupees(r.duesPaise) }))}
            {tile(t("leads"), r.leads.new, t("leadsBooked", { booked: r.leads.booked, won: r.leads.won }))}
            {tile(
              t("reviews"),
              r.reviews.asked,
              t("reviewsSub", { good: r.reviews.good, bad: r.reviews.bad }),
            )}
          </div>
          {r.tomorrow ? (
            <p className="text-sm text-slate-600">
              {t("tomorrow", { booked: r.tomorrow.booked, unconfirmed: r.tomorrow.unconfirmed })}
            </p>
          ) : null}

          <Card>
            <h2 className="mb-2 font-semibold">{t("recoveredDetail")}</h2>
            {r.recovered.payments.length === 0 ? (
              <p className="text-sm text-slate-500">{t("noneRecovered")}</p>
            ) : null}
            {Object.keys(r.recovered.byKind).length ? (
              <p className="mb-2 text-xs text-slate-600">
                {Object.entries(r.recovered.byKind)
                  .map(([k, v]) => `${t(`kinds.${k}`)}: ${rupees(v)}`)
                  .join(" · ")}
              </p>
            ) : null}
            <ul className="divide-y divide-slate-100 text-sm">
              {r.recovered.payments.map((p) => (
                <li key={p.paymentId} className="flex justify-between gap-2 py-1.5">
                  <span>
                    <Link href={`/patients/${p.patientId}`} className="text-brand-700 underline">
                      {p.patient}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {t("paidAfter", {
                        kind: t(`kinds.${p.kind}`),
                        followup: new Date(p.followupAt).toLocaleDateString(
                          locale === "hi" ? "hi-IN" : "en-IN",
                        ),
                        paid: new Date(p.paidAt).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN"),
                      })}
                    </span>
                  </span>
                  <span className="font-medium">{rupees(p.amountPaise)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {manage && nightly !== null ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={nightly}
            onChange={(e) => {
              const v = e.target.checked;
              setNightly(v);
              void api("/v1/reports/settings", { method: "PUT", body: { nightly: v } }).catch(() =>
                setNightly(!v),
              );
            }}
          />
          {t("nightly")}
        </label>
      ) : null}
    </div>
  );
}

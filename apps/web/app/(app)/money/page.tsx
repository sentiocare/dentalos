"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Spinner, useToast } from "../../../components/ui";
import { useClinicConfig } from "../../../lib/data";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";
import { formatRupees, todayIn, zonedInstant } from "../../../lib/time";

type ByMethod = { cash: number; upi: number; card: number; bank: number; online: number };
interface Collections {
  days: { day: string; receivedPaise: number; refundedPaise: number; byMethod: ByMethod }[];
  totals: { chargedPaise: number; receivedPaise: number; refundedPaise: number; byMethod: ByMethod };
  dues: { patients: number; totalPaise: number };
}
interface Due {
  patientId: string;
  name: string;
  phone: string | null;
  fileNumber: string | null;
  balancePaise: number;
  lastChargeAt: string | null;
  reminding: boolean;
}
interface ExportRow {
  at: string;
  fileNumber: string | null;
  patient: string;
  kind: string;
  description: string;
  method: string | null;
  reference: string | null;
  amountPaise: number;
  gstPaise: number;
  receipt: string | null;
  invoice: string | null;
  correction: boolean;
}

type Period = "today" | "month" | "last_month";

/** Collections and dues (Build Prompt §5.10): money received by day and method, who owes what, Excel export. */
export default function MoneyPage() {
  const t = useTranslations("money");
  const tb = useTranslations("billing");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api } = useSession();
  const config = useClinicConfig();
  const toast = useToast();
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<Collections | null>(null);
  const [dues, setDues] = useState<Due[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const rupees = (p: number) => formatRupees(p, locale);

  const range = useMemo(() => {
    const today = todayIn(tz);
    const [y, m] = today.split("-").map(Number) as [number, number];
    const monthStart = `${today.slice(0, 7)}-01`;
    const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
    const next = (d: string) => {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() + 1);
      return x.toISOString().slice(0, 10);
    };
    const [from, to] =
      period === "today"
        ? [today, next(today)]
        : period === "month"
          ? [monthStart, next(today)]
          : [prev, monthStart];
    return {
      from: zonedInstant(from, 0, tz).toISOString(),
      to: zonedInstant(to, 0, tz).toISOString(),
      label: `${from}_${to}`,
    };
  }, [period, tz]);

  const load = useCallback(async () => {
    setData(null);
    const q = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    const [c, d] = await Promise.all([api<Collections>(`/v1/collections?${q}`), api<Due[]>("/v1/dues")]);
    setData(c);
    setDues(d);
  }, [api, range]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const q = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
      const rows = await api<ExportRow[]>(`/v1/ledger/export?${q}`);
      const { default: writeExcelFile } = await import("write-excel-file/browser");
      const header = [
        t("xls.date"),
        t("xls.file"),
        t("xls.patient"),
        t("xls.type"),
        t("xls.description"),
        t("xls.method"),
        t("xls.reference"),
        t("xls.amount"),
        t("xls.gst"),
        t("xls.receipt"),
        t("xls.invoice"),
      ].map((value) => ({ value, fontWeight: "bold" as const }));
      const body = rows.map((r) => [
        { value: r.at },
        { value: r.fileNumber ?? "" },
        { value: r.patient },
        { value: r.correction ? `${tb(`kinds.${r.kind}`)} (${t("xls.correction")})` : tb(`kinds.${r.kind}`) },
        { value: r.description },
        { value: r.method ? tb(`methods.${r.method}`) : "" },
        { value: r.reference ?? "" },
        { value: (r.kind === "payment" ? -r.amountPaise : r.amountPaise) / 100, format: "#,##0.00" },
        { value: r.gstPaise / 100, format: "#,##0.00" },
        { value: r.receipt ?? "" },
        { value: r.invoice ?? "" },
      ]);
      await writeExcelFile([header, ...body], {
        columns: [16, 10, 24, 14, 30, 12, 16, 12, 10, 18, 18].map((width) => ({ width })),
      }).toFile(`payments_${range.label}.xlsx`);
    } catch {
      toast(tc("error"), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex gap-2" role="tablist">
        {(["today", "month", "last_month"] as const).map((p) => (
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
      </div>

      {!data ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2" data-testid="collections">
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">{t("received")}</p>
              <p className="text-lg font-semibold">
                {rupees(data.totals.receivedPaise - data.totals.refundedPaise)}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">{t("billed")}</p>
              <p className="text-lg font-semibold">{rupees(data.totals.chargedPaise)}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-sm font-medium">{t("byMethod")}</p>
            <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-5">
              {(["cash", "upi", "card", "bank", "online"] as const).map((m) => (
                <div key={m}>
                  <dt className="text-xs text-slate-500">
                    {tb(`methods.${m === "online" ? "gateway_link" : m}`)}
                  </dt>
                  <dd className="font-medium">{rupees(data.totals.byMethod[m])}</dd>
                </div>
              ))}
            </dl>
            {data.totals.refundedPaise ? (
              <p className="mt-2 text-xs text-slate-500">
                {t("refunded", { amount: rupees(data.totals.refundedPaise) })}
              </p>
            ) : null}
          </div>
          <Button variant="secondary" busy={exporting} onClick={() => void exportExcel()}>
            {t("export")}
          </Button>
        </>
      )}

      <h2 className="pt-2 font-semibold">
        {t("dues")}
        {data ? ` · ${data.dues.patients} · ${rupees(data.dues.totalPaise)}` : ""}
      </h2>
      {dues && dues.length === 0 ? <EmptyState>{t("noDues")}</EmptyState> : null}
      <ul
        className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white"
        data-testid="dues"
      >
        {(dues ?? []).map((d) => (
          <li key={d.patientId}>
            <Link
              href={`/patients/${d.patientId}`}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.name}</span>
                <span className="text-xs text-slate-500">
                  {displayPhone(d.phone)}
                  {d.reminding ? ` · ${t("reminding")}` : ""}
                </span>
              </span>
              <span className="shrink-0 font-semibold text-amber-900">{rupees(d.balancePaise)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

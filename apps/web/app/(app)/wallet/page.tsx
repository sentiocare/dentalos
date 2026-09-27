"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, Input, Select, Spinner, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import { formatRupees } from "../../../lib/time";

interface Wallet {
  enforced: boolean;
  state: "active" | "low" | "grace" | "suspended";
  balancePaise: number;
  thresholdPaise: number;
  rechargeAmountPaise: number;
  monthlyCapPaise: number | null;
  autoRecharge: boolean;
  spentThisMonthPaise: number;
  capReached: boolean;
  license: {
    sku: string;
    status: string;
    purchased_at: string | null;
    updates_support_until: string | null;
    checkout_url: string | null;
  } | null;
  mandate: {
    method: string | null;
    status: string;
    max_amount_paise: number;
    last_failure: string | null;
    registration_url: string | null;
  } | null;
  recharges: {
    id: string;
    via: string;
    amount_paise: number;
    status: string;
    debit_after: string | null;
    link_url: string | null;
    failure: string | null;
    created_at: string;
  }[];
  invoices: { id: string; number: string; kind: string; total_paise: number; issued_at: string }[];
  thisMonth: {
    byKind: { kind: string; quantity: number; totalPaise: number; events: number }[];
    totalPaise: number;
  };
}

const STATE_STYLE: Record<Wallet["state"], string> = {
  active: "bg-emerald-50 text-emerald-900 border-emerald-200",
  low: "bg-amber-50 text-amber-900 border-amber-200",
  grace: "bg-orange-50 text-orange-900 border-orange-200",
  suspended: "bg-red-50 text-red-900 border-red-200",
};

/**
 * The Sentio usage wallet for the clinic owner (Build Prompt §4): one-time license, then pay only for use.
 * Balance, what it was spent on this month, top-ups, automatic recharge and Sentio's invoices.
 */
export default function WalletPage() {
  const t = useTranslations("wallet");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, openPdf } = useSession();
  const toast = useToast();
  const [w, setW] = useState<Wallet | null>(null);
  const [topup, setTopup] = useState("2000");
  const [settings, setSettings] = useState({ threshold: "", recharge: "", cap: "", auto: true });
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<"upi_autopay" | "card" | "enach">("upi_autopay");
  const rupees = (p: number) => formatRupees(p, locale);

  const load = useCallback(async () => {
    const data = await api<Wallet>("/v1/wallet");
    setW(data);
    setSettings({
      threshold: String(data.thresholdPaise / 100),
      recharge: String(data.rechargeAmountPaise / 100),
      cap: data.monthlyCapPaise ? String(data.monthlyCapPaise / 100) : "",
      auto: data.autoRecharge,
    });
  }, [api]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!w)
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );

  const openLink = (url: string) => window.open(url, "_blank", "noopener");
  const capPct = w.monthlyCapPaise
    ? Math.min(100, Math.round((w.spentThisMonthPaise * 100) / w.monthlyCapPaise))
    : null;

  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>

      <div className={`rounded-2xl border p-4 ${STATE_STYLE[w.state]}`} data-testid="wallet-state">
        <p className="text-sm">{t("balance")}</p>
        <p className="text-2xl font-semibold">{rupees(w.balancePaise)}</p>
        <p className="mt-1 text-sm">{w.enforced ? t(`states.${w.state}`) : t("notStarted")}</p>
      </div>

      <Card>
        <h2 className="mb-2 font-semibold">{t("addMoney")}</h2>
        <div className="flex gap-2">
          <Input
            aria-label={t("amountRupees")}
            inputMode="numeric"
            value={topup}
            onChange={(e) => setTopup(e.target.value)}
          />
          <Button
            busy={busy}
            onClick={() =>
              void run(async () => {
                const res = await api<{ url: string }>("/v1/wallet/topup", {
                  method: "POST",
                  body: { amountPaise: Math.round(Number(topup) * 100) },
                });
                openLink(res.url);
              })
            }
          >
            {t("pay")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">{t("gstNote")}</p>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{t("thisMonth")}</h2>
        {w.thisMonth.byKind.length === 0 ? <p className="text-sm text-slate-500">{t("noUsage")}</p> : null}
        <ul className="divide-y divide-slate-100 text-sm">
          {w.thisMonth.byKind.map((k) => (
            <li key={k.kind} className="flex justify-between py-1.5">
              <span>
                {t(`kinds.${k.kind}`)}
                <span className="text-xs text-slate-500">
                  {" "}
                  · {Math.round(k.quantity).toLocaleString(locale === "hi" ? "hi-IN" : "en-IN")}
                </span>
              </span>
              <span className="font-medium">{rupees(k.totalPaise)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
          <span>{t("total")}</span>
          <span>{rupees(w.thisMonth.totalPaise)}</span>
        </p>
        {capPct !== null ? (
          <p className={`mt-1 text-xs ${w.capReached ? "text-red-700" : "text-slate-500"}`}>
            {t("capUsed", { pct: capPct, cap: rupees(w.monthlyCapPaise!) })}
          </p>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{t("autoRecharge")}</h2>
        {w.mandate?.status === "active" ? (
          <p className="text-sm">
            {t("mandateActive", {
              method: t(`methods.${w.mandate.method ?? "upi_autopay"}`),
              max: rupees(w.mandate.max_amount_paise),
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">
              {w.mandate?.status === "failed"
                ? t("mandateFailed")
                : w.mandate?.status === "pending"
                  ? t("mandatePending")
                  : t("mandateNone")}
            </p>
            <div className="flex gap-2">
              <Select
                aria-label={t("method")}
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
              >
                <option value="upi_autopay">{t("methods.upi_autopay")}</option>
                <option value="card">{t("methods.card")}</option>
                <option value="enach">{t("methods.enach")}</option>
              </Select>
              <Button
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    const res = await api<{ url: string }>("/v1/wallet/mandate", {
                      method: "POST",
                      body: { method },
                    });
                    openLink(res.url);
                    await load();
                  })
                }
              >
                {t("setUp")}
              </Button>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">{t("rbiNote")}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label={t("lowLevel")}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={settings.threshold}
                onChange={(e) => setSettings({ ...settings, threshold: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("rechargeAmount")}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={settings.recharge}
                onChange={(e) => setSettings({ ...settings, recharge: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("monthlyCap")} hint={t("capHint")}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={settings.cap}
                onChange={(e) => setSettings({ ...settings, cap: e.target.value })}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-3 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={settings.auto}
              onChange={(e) => setSettings({ ...settings, auto: e.target.checked })}
            />
            {t("autoOn")}
          </label>
        </div>
        <Button
          variant="secondary"
          busy={busy}
          onClick={() =>
            void run(async () => {
              await api("/v1/wallet", {
                method: "PATCH",
                body: {
                  thresholdPaise: Math.round(Number(settings.threshold) * 100),
                  rechargeAmountPaise: Math.round(Number(settings.recharge) * 100),
                  monthlyCapPaise: settings.cap.trim() ? Math.round(Number(settings.cap) * 100) : null,
                  autoRecharge: settings.auto,
                },
              });
              toast(tc("saved"));
              await load();
            })
          }
        >
          {tc("save")}
        </Button>
      </Card>

      {w.recharges.length ? (
        <Card>
          <h2 className="mb-2 font-semibold">{t("recharges")}</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {w.recharges.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  {new Date(r.created_at).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN")} ·{" "}
                  {t(`rechargeStatus.${r.status}`)}
                  {r.status === "notified" && r.debit_after
                    ? ` · ${t("debitOn", { date: new Date(r.debit_after).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN") })}`
                    : ""}
                  {r.status === "link_sent" && r.link_url ? (
                    <button className="ml-2 text-brand-700 underline" onClick={() => openLink(r.link_url!)}>
                      {t("pay")}
                    </button>
                  ) : null}
                </span>
                <span className="font-medium">{rupees(r.amount_paise)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 font-semibold">{t("license")}</h2>
        {w.license ? (
          <p className="text-sm">
            {t("licenseLine", { sku: w.license.sku, status: t(`licenseStatus.${w.license.status}`) })}
            {w.license.updates_support_until
              ? ` · ${t("supportUntil", { date: w.license.updates_support_until })}`
              : ""}
            {w.license.status === "pending" && w.license.checkout_url ? (
              <button
                className="ml-2 text-brand-700 underline"
                onClick={() => openLink(w.license!.checkout_url!)}
              >
                {t("pay")}
              </button>
            ) : null}
          </p>
        ) : (
          <p className="text-sm text-slate-500">{t("noLicense")}</p>
        )}
        {w.invoices.length ? (
          <>
            <h3 className="mt-3 text-sm font-medium">{t("invoices")}</h3>
            <ul className="text-sm">
              {w.invoices.map((i) => (
                <li key={i.id} className="flex justify-between py-1">
                  <button
                    className="text-brand-700 underline"
                    onClick={() => void openPdf(`/v1/wallet/invoices/${i.id}/pdf`)}
                  >
                    {i.number}
                  </button>
                  <span>{rupees(i.total_paise)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Card>
    </div>
  );
}

"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Sheet,
  Spinner,
  useToast,
} from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import { formatRupees } from "../../../lib/time";

interface ClinicRow {
  id: string;
  name: string;
  city: string | null;
  balancePaise: number;
  state: string;
  enforced: boolean;
  license: string | null;
  mandate: string | null;
  usage30dPaise: number;
  margin30dPaise: number;
  failedPayments: number;
}
interface ClinicDetail {
  clinic: { id: string; name: string; city: string | null; state: string | null; gstin: string | null };
  wallet: { balance_paise: number; state: string; enforced: boolean; monthly_cap_paise: number | null };
  licenses: {
    id: string;
    sku: string;
    price_paise: number;
    status: string;
    updates_support_until: string | null;
    checkout_url: string | null;
  }[];
  mandates: {
    id: string;
    method: string | null;
    status: string;
    consecutive_failures: number;
    last_failure: string | null;
  }[];
  recharges: {
    id: string;
    via: string;
    amount_paise: number;
    status: string;
    failure: string | null;
    created_at: string;
  }[];
  invoices: { id: string; number: string; kind: string; total_paise: number; issued_at: string }[];
  usage: { kind: string; quantity: number; total: number; cost: number }[];
}
interface Rate {
  id: string;
  clinic_id: string | null;
  kind: string;
  unit: string;
  provider_cost_paise: number;
  margin_pct: number;
  margin_paise: number;
  effective_from: string;
}
interface Recon {
  period_start: string;
  period_end: string;
  provider: string;
  our_cost_paise: number;
  provider_cost_paise: number | null;
  drift_pct: number | null;
  status: string;
}
interface Health {
  providers: { role: string; name: string; ok: boolean; detail?: string; latencyMs?: number }[];
  heartbeats: { service: string; age_sec: number }[];
  failedPayments: {
    id: string;
    clinic: string;
    amount_paise: number;
    failure: string | null;
    created_at: string;
  }[];
  failedMessages: number;
}

type Tab = "clinics" | "rates" | "reconciliation" | "health";

/** The Sentio admin panel (PLAN Phase 5): clinics, license, wallet, usage, margins, payments, health. */
export default function AdminPage() {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, me, openPdf } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("clinics");
  const [clinics, setClinics] = useState<ClinicRow[] | null>(null);
  const [detail, setDetail] = useState<ClinicDetail | null>(null);
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [recon, setRecon] = useState<Recon[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [lic, setLic] = useState({ sku: "standard", price: "49999", months: "12" });
  const [adj, setAdj] = useState({ amount: "", note: "" });
  const [rate, setRate] = useState({ kind: "telephony_min", unit: "minute", cost: "", pct: "50", from: "" });
  const [bills, setBills] = useState({
    start: "",
    end: "",
    telephony: "",
    speech: "",
    llm: "",
    whatsapp: "",
    sms: "",
  });
  const rupees = (p: number) => formatRupees(p, locale);

  const load = useCallback(async () => {
    if (tab === "clinics") setClinics(await api<ClinicRow[]>("/v1/admin/clinics"));
    if (tab === "rates") setRates(await api<Rate[]>("/v1/admin/rates"));
    if (tab === "reconciliation") setRecon(await api<Recon[]>("/v1/admin/reconciliation"));
    if (tab === "health") setHealth(await api<Health>("/v1/admin/health"));
  }, [api, tab]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };
  const openClinic = (id: string) =>
    void run(async () => setDetail(await api<ClinicDetail>(`/v1/admin/clinics/${id}`)));
  const refreshDetail = async () => {
    if (detail) setDetail(await api<ClinicDetail>(`/v1/admin/clinics/${detail.clinic.id}`));
    await load();
  };

  if (!me?.platformAdmin) return <EmptyState>{t("only")}</EmptyState>;

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex flex-wrap gap-2" role="tablist">
        {(["clinics", "rates", "reconciliation", "health"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-full px-3 py-1 text-sm ${tab === k ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      {tab === "clinics" ? (
        !clinics ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm" data-testid="admin-clinics">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">{t("clinic")}</th>
                  <th className="px-3 py-2">{t("balance")}</th>
                  <th className="px-3 py-2">{t("license")}</th>
                  <th className="px-3 py-2">{t("mandate")}</th>
                  <th className="px-3 py-2 text-right">{t("usage30")}</th>
                  <th className="px-3 py-2 text-right">{t("margin30")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clinics.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => openClinic(c.id)}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{c.name}</span>
                      {c.failedPayments ? (
                        <span className="ml-1 text-xs text-red-700">⚠ {c.failedPayments}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {rupees(c.balancePaise)}
                      <span className="block text-xs text-slate-500">
                        {c.enforced ? c.state : t("notBilled")}
                      </span>
                    </td>
                    <td className="px-3 py-2">{c.license ?? "—"}</td>
                    <td className="px-3 py-2">{c.mandate ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{rupees(c.usage30dPaise)}</td>
                    <td className="px-3 py-2 text-right">{rupees(c.margin30dPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "rates" ? (
        <>
          <Card>
            <h2 className="mb-2 font-semibold">{t("newRate")}</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Field label={t("kind")}>
                {(id) => (
                  <Select
                    id={id}
                    value={rate.kind}
                    onChange={(e) => setRate({ ...rate, kind: e.target.value })}
                  >
                    {[
                      "telephony_min",
                      "stt_sec",
                      "tts_char",
                      "llm_input_token",
                      "llm_output_token",
                      "wa_utility",
                      "wa_marketing",
                      "wa_authentication",
                      "sms_segment",
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t("unit")}>
                {(id) => (
                  <Input
                    id={id}
                    value={rate.unit}
                    onChange={(e) => setRate({ ...rate, unit: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("costPaise")}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={rate.cost}
                    onChange={(e) => setRate({ ...rate, cost: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("marginPct")}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={rate.pct}
                    onChange={(e) => setRate({ ...rate, pct: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("from")}>
                {(id) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    value={rate.from}
                    onChange={(e) => setRate({ ...rate, from: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Button
              className="mt-2"
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await api("/v1/admin/rates", {
                    method: "POST",
                    body: {
                      kind: rate.kind,
                      unit: rate.unit,
                      providerCostPaise: Number(rate.cost),
                      marginPct: Number(rate.pct),
                      effectiveFrom: new Date(rate.from || Date.now() + 60_000).toISOString(),
                    },
                  });
                  await load();
                }, tc("saved"))
              }
            >
              {tc("add")}
            </Button>
          </Card>
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm">
            {(rates ?? []).map((r) => (
              <li key={r.id} className="flex justify-between gap-2 px-3 py-2">
                <span>
                  {r.kind}{" "}
                  <span className="text-xs text-slate-500">
                    {r.clinic_id ? t("clinicRate") : t("defaultRate")} ·{" "}
                    {t("fromDate", { date: r.effective_from.slice(0, 10) })}
                  </span>
                </span>
                <span>
                  {r.provider_cost_paise}p / {r.unit} + {r.margin_pct}%
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {tab === "reconciliation" ? (
        <>
          <Card>
            <h2 className="mb-1 font-semibold">{t("enterBills")}</h2>
            <p className="mb-2 text-xs text-slate-500">{t("billsHint")}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label={t("periodStart")}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={bills.start}
                    onChange={(e) => setBills({ ...bills, start: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("periodEnd")}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={bills.end}
                    onChange={(e) => setBills({ ...bills, end: e.target.value })}
                  />
                )}
              </Field>
              {(["telephony", "speech", "llm", "whatsapp", "sms"] as const).map((p) => (
                <Field key={p} label={t(`providers.${p}`)}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      placeholder="₹"
                      value={bills[p]}
                      onChange={(e) => setBills({ ...bills, [p]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
            </div>
            <Button
              className="mt-2"
              busy={busy}
              onClick={() =>
                void run(async () => {
                  const b: Record<string, number | null> = {};
                  for (const p of ["telephony", "speech", "llm", "whatsapp", "sms"] as const)
                    b[p] = bills[p].trim() ? Math.round(Number(bills[p]) * 100) : null;
                  await api("/v1/admin/reconciliation", {
                    method: "POST",
                    body: { periodStart: bills.start, periodEnd: bills.end, bills: b },
                  });
                  await load();
                })
              }
            >
              {t("compare")}
            </Button>
          </Card>
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm">
            {(recon ?? []).map((r) => (
              <li
                key={`${r.period_start}${r.period_end}${r.provider}`}
                className="flex justify-between gap-2 px-3 py-2"
              >
                <span>
                  {r.provider}{" "}
                  <span className="text-xs text-slate-500">
                    {r.period_start} → {r.period_end}
                  </span>
                </span>
                <span
                  className={
                    r.status === "drift"
                      ? "text-red-700"
                      : r.status === "ok"
                        ? "text-emerald-700"
                        : "text-slate-500"
                  }
                >
                  {t(`recon.${r.status}`)}
                  {r.drift_pct !== null ? ` · ${r.drift_pct.toFixed(2)}%` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {tab === "health" && health ? (
        <>
          <ul
            className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm"
            data-testid="admin-health"
          >
            {health.providers.map((p) => (
              <li key={p.role} className="flex justify-between px-3 py-2">
                <span>
                  {p.role} <span className="text-xs text-slate-500">{p.name}</span>
                </span>
                <span className={p.ok ? "text-emerald-700" : "text-red-700"}>
                  {p.ok ? t("ok") : (p.detail ?? t("down"))}
                </span>
              </li>
            ))}
            {health.heartbeats.map((h) => (
              <li key={h.service} className="flex justify-between px-3 py-2">
                <span>{h.service}</span>
                <span className={h.age_sec < 180 ? "text-emerald-700" : "text-red-700"}>
                  {t("secondsAgo", { n: h.age_sec })}
                </span>
              </li>
            ))}
            <li className="flex justify-between px-3 py-2">
              <span>{t("failedMessages")}</span>
              <span>{health.failedMessages}</span>
            </li>
          </ul>
          <h2 className="font-semibold">{t("failedPayments")}</h2>
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm">
            {health.failedPayments.map((f) => (
              <li key={f.id} className="flex justify-between gap-2 px-3 py-2">
                <span>
                  {f.clinic} <span className="text-xs text-slate-500">{f.failure}</span>
                </span>
                <span>{rupees(f.amount_paise)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail?.clinic.name ?? ""}>
        {detail ? (
          <div className="space-y-4 text-sm">
            <p>
              {t("balance")}: <b>{rupees(Number(detail.wallet.balance_paise))}</b> ·{" "}
              {detail.wallet.enforced ? detail.wallet.state : t("notBilled")}
            </p>
            <div className="space-y-2">
              <p className="font-medium">{t("sellLicense")}</p>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  aria-label={t("sku")}
                  value={lic.sku}
                  onChange={(e) => setLic({ ...lic, sku: e.target.value })}
                />
                <Input
                  aria-label={t("priceRupees")}
                  inputMode="numeric"
                  value={lic.price}
                  onChange={(e) => setLic({ ...lic, price: e.target.value })}
                />
                <Input
                  aria-label={t("months")}
                  inputMode="numeric"
                  value={lic.months}
                  onChange={(e) => setLic({ ...lic, months: e.target.value })}
                />
              </div>
              <Button
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/v1/admin/clinics/${detail.clinic.id}/license`, {
                      method: "POST",
                      body: {
                        sku: lic.sku,
                        pricePaise: Math.round(Number(lic.price) * 100),
                        updatesMonths: Number(lic.months),
                      },
                    });
                    await refreshDetail();
                  }, t("linkSent"))
                }
              >
                {t("sendLicenseLink")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/v1/admin/clinics/${detail.clinic.id}/mandate`, {
                      method: "POST",
                      body: { method: "upi_autopay" },
                    });
                    await refreshDetail();
                  }, t("linkSent"))
                }
              >
                {t("sendMandateLink")}
              </Button>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/v1/admin/clinics/${detail.clinic.id}/wallet`, {
                      method: "POST",
                      body: { enforced: !detail.wallet.enforced },
                    });
                    await refreshDetail();
                  })
                }
              >
                {detail.wallet.enforced ? t("stopBilling") : t("startBilling")}
              </Button>
            </div>
            <div className="space-y-2">
              <p className="font-medium">{t("adjust")}</p>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label={t("amountRupees")}
                  inputMode="decimal"
                  placeholder="±₹"
                  value={adj.amount}
                  onChange={(e) => setAdj({ ...adj, amount: e.target.value })}
                />
                <Input
                  aria-label={t("reason")}
                  placeholder={t("reason")}
                  value={adj.note}
                  onChange={(e) => setAdj({ ...adj, note: e.target.value })}
                />
              </div>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/v1/admin/clinics/${detail.clinic.id}/wallet`, {
                      method: "POST",
                      body: { adjustmentPaise: Math.round(Number(adj.amount) * 100), note: adj.note },
                    });
                    setAdj({ amount: "", note: "" });
                    await refreshDetail();
                  }, tc("saved"))
                }
              >
                {tc("save")}
              </Button>
            </div>
            <div>
              <p className="font-medium">{t("usage30")}</p>
              <ul>
                {detail.usage.map((u) => (
                  <li key={u.kind} className="flex justify-between">
                    <span>{u.kind}</span>
                    <span>
                      {rupees(Number(u.total))}{" "}
                      <span className="text-xs text-slate-500">
                        ({t("costShort")} {rupees(Math.round(u.cost))})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">{t("recharges")}</p>
              <ul>
                {detail.recharges.map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span>
                      {r.created_at.slice(0, 10)} · {r.via} · {r.status}
                      {r.failure ? <span className="text-xs text-red-700"> · {r.failure}</span> : null}
                    </span>
                    <span>{rupees(r.amount_paise)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">{t("invoices")}</p>
              <ul>
                {detail.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between">
                    <button
                      className="text-brand-700 underline"
                      onClick={() => void openPdf(`/v1/admin/invoices/${i.id}/pdf`)}
                    >
                      {i.number}
                    </button>
                    <span>{rupees(i.total_paise)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

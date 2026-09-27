"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ApiError, newIdempotencyKey } from "../lib/api";
import { useClinicConfig } from "../lib/data";
import { useSession } from "../lib/session";
import { formatRupees } from "../lib/time";
import { Button, Input, Select, Sheet, Spinner, useToast } from "./ui";

type Method = "cash" | "upi" | "card" | "bank";
const METHODS: Method[] = ["cash", "upi", "card", "bank"];

interface Checkout {
  appointment: { id: string; status: string; doctorName: string; procedureName: string | null };
  patient: { id: string; name: string; phone: string | null };
  entries: {
    id: string;
    kind: string;
    amountPaise: number;
    method: string | null;
    description: string;
    receiptId: string | null;
  }[];
  chargedPaise: number;
  paidPaise: number;
  balancePaise: number;
  suggested: {
    procedureTypeId: string;
    treatmentStepId: string | null;
    description: string;
    amountPaise: number | null;
    priceRange: { min: number; max: number } | null;
  }[];
  nextSitting: { id: string; name: string; from: string | null; to: string | null } | null;
}

interface Line {
  key: string;
  procedureTypeId: string | null;
  treatmentStepId: string | null;
  description: string;
  amount: string;
  hint: string | null;
}

const toPaise = (s: string) => Math.round(Number(s.replace(/[,₹\s]/g, "")) * 100);
const valid = (s: string) =>
  s.trim() !== "" && Number.isFinite(Number(s.replace(/[,₹\s]/g, ""))) && toPaise(s) > 0;

/**
 * Settling a visit at the desk, in one place: what this visit costs (the treatment's price filled in),
 * what the patient owed before, payment by cash/UPI/card, the receipt (printed or on WhatsApp) and the
 * next visit.
 */
export function CheckoutSheet({
  appointmentId,
  onClose,
  onChanged,
  onBookNext,
}: {
  appointmentId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onBookNext: (patient: { id: string; name: string; phone: string | null }) => void;
}) {
  const t = useTranslations("checkout");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, can, openPdf } = useSession();
  const config = useClinicConfig();
  const toast = useToast();
  const [data, setData] = useState<Checkout | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [sendReceipt, setSendReceipt] = useState(true);
  const [payKey, setPayKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState<{ number: string; receiptId: string; amountPaise: number } | null>(null);
  const rupees = (p: number) => formatRupees(p, locale);
  const write = can("billing.write");

  const load = useCallback(async () => {
    if (!appointmentId) return;
    const d = await api<Checkout>(`/v1/appointments/${appointmentId}/checkout`);
    setData(d);
    const initial = d.suggested.map((s) => ({
      key: newIdempotencyKey(),
      procedureTypeId: s.procedureTypeId,
      treatmentStepId: s.treatmentStepId,
      description: s.description,
      amount: s.amountPaise ? String(s.amountPaise / 100) : "",
      hint: s.priceRange ? `${rupees(s.priceRange.min)} – ${rupees(s.priceRange.max)}` : null,
    }));
    setLines(initial);
    const newTotal = initial.reduce((sum, l) => sum + (valid(l.amount) ? toPaise(l.amount) : 0), 0);
    const due = d.balancePaise + newTotal;
    setAmount(due > 0 ? String(due / 100) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, appointmentId]);

  useEffect(() => {
    setData(null);
    setPaid(null);
    setPayKey(newIdempotencyKey());
    setMethod("cash");
    if (appointmentId) void load().catch(() => toast(tc("error"), "error"));
  }, [appointmentId, load, tc, toast]);

  if (!appointmentId)
    return (
      <Sheet open={false} onClose={onClose} title="">
        {null}
      </Sheet>
    );

  const newTotal = lines.reduce((s, l) => s + (valid(l.amount) ? toPaise(l.amount) : 0), 0);
  const visitDue = data ? data.chargedPaise - data.paidPaise : 0;
  const before = data ? data.balancePaise - visitDue : 0;
  const toCollect = data ? data.balancePaise + newTotal : 0;
  const procedures = (config.data?.procedures ?? []).filter((p) => p.active);
  const linesOk = lines.every((l) => valid(l.amount) && l.description.trim());

  const saveCharges = async () => {
    for (const l of lines) {
      await api(`/v1/patients/${data!.patient.id}/charges`, {
        method: "POST",
        body: {
          amountPaise: toPaise(l.amount),
          description: l.description.trim(),
          procedureTypeId: l.procedureTypeId,
          treatmentStepId: l.treatmentStepId,
          appointmentId,
          clientKey: l.key,
        },
      });
    }
  };

  const finish = async (takePayment: boolean) => {
    if (!data || !linesOk) return;
    if (takePayment && !valid(amount)) return;
    setBusy(true);
    try {
      await saveCharges();
      if (takePayment) {
        const r = await api<{ receiptNumber: string; receiptId: string; receiptSent: boolean }>(
          `/v1/patients/${data.patient.id}/payments`,
          {
            method: "POST",
            body: {
              amountPaise: toPaise(amount),
              method,
              appointmentId,
              sendReceipt: sendReceipt && !!data.patient.phone,
              clientKey: payKey,
            },
          },
        );
        setPaid({ number: r.receiptNumber, receiptId: r.receiptId, amountPaise: toPaise(amount) });
      } else {
        toast(t("billSaved"));
        onClose();
      }
      onChanged();
      setLines([]);
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (key: string, change: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));

  return (
    <Sheet open onClose={onClose} title={t("title")}>
      {!data ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : paid ? (
        <div className="space-y-4" data-testid="checkout-paid">
          <div className="rounded-2xl bg-emerald-50 p-4 text-center text-emerald-900">
            <p className="text-sm">{t("paidFor", { name: data.patient.name })}</p>
            <p className="text-3xl font-semibold">{rupees(paid.amountPaise)}</p>
            <p className="text-sm">{t("receiptNo", { number: paid.number })}</p>
            {data.balancePaise > 0 ? (
              <p className="mt-1 text-sm font-medium text-amber-800">
                {t("stillOwes", { amount: rupees(data.balancePaise) })}
              </p>
            ) : null}
          </div>
          {data.nextSitting ? (
            <p className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">
              {t("nextSitting", { name: data.nextSitting.name })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                void openPdf(`/v1/receipts/${paid.receiptId}/pdf`).catch(() => toast(tc("error"), "error"))
              }
            >
              {t("printReceipt")}
            </Button>
            <Button onClick={() => onBookNext(data.patient)}>{t("bookNext")}</Button>
          </div>
          <Button variant="ghost" className="w-full" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-semibold">{data.patient.name}</p>
            <p className="text-sm text-slate-600">
              {[data.appointment.procedureName, data.appointment.doctorName].filter(Boolean).join(" · ")}
            </p>
          </div>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t("thisVisit")}</h3>
            {data.entries.length === 0 && lines.length === 0 ? (
              <p className="text-sm text-slate-500">{t("nothingBilled")}</p>
            ) : null}
            <ul className="space-y-1 text-sm">
              {data.entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2">
                  <span>
                    {e.kind === "payment" ? t("paidBy", { method: t(`methods.${e.method}`) }) : e.description}
                  </span>
                  <span className="flex items-center gap-2">
                    {e.receiptId ? (
                      <button
                        className="text-xs text-brand-700 underline"
                        onClick={() => void openPdf(`/v1/receipts/${e.receiptId}/pdf`).catch(() => {})}
                      >
                        {t("receipt")}
                      </button>
                    ) : null}
                    <span className={e.kind === "payment" ? "text-emerald-700" : ""}>
                      {e.kind === "payment" ? "−" : ""}
                      {rupees(e.amountPaise)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {write
              ? lines.map((l) => (
                  <div key={l.key} className="flex items-start gap-2">
                    <div className="flex-1">
                      <Input
                        aria-label={t("item")}
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      />
                    </div>
                    <div className="w-32">
                      <Input
                        aria-label={t("amountFor", { item: l.description })}
                        inputMode="decimal"
                        placeholder="₹"
                        value={l.amount}
                        onChange={(e) => {
                          const next = e.target.value;
                          const delta =
                            (valid(next) ? toPaise(next) : 0) - (valid(l.amount) ? toPaise(l.amount) : 0);
                          updateLine(l.key, { amount: next });
                          setAmount((a) => {
                            const cur = valid(a) ? toPaise(a) : 0;
                            const v = Math.max(0, cur + delta);
                            return v ? String(v / 100) : "";
                          });
                        }}
                      />
                      {l.hint ? <p className="mt-0.5 text-xs text-slate-500">{l.hint}</p> : null}
                    </div>
                    <button
                      aria-label={tc("remove")}
                      className="px-1 pt-2 text-slate-400 hover:text-red-600"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      ✕
                    </button>
                  </div>
                ))
              : null}
            {write ? (
              <Select
                aria-label={t("addItem")}
                value=""
                onChange={(e) => {
                  const p = procedures.find((x) => x.id === e.target.value);
                  if (!p) return;
                  const price = p.price_min_paise ?? 0;
                  setLines((ls) => [
                    ...ls,
                    {
                      key: newIdempotencyKey(),
                      procedureTypeId: p.id,
                      treatmentStepId: null,
                      description: p.name,
                      amount: price ? String(price / 100) : "",
                      hint:
                        p.price_min_paise && p.price_max_paise && p.price_min_paise !== p.price_max_paise
                          ? `${rupees(p.price_min_paise)} – ${rupees(p.price_max_paise)}`
                          : null,
                    },
                  ]);
                  if (price) setAmount((a) => String(((valid(a) ? toPaise(a) : 0) + price) / 100));
                }}
              >
                <option value="">+ {t("addItem")}</option>
                {procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {locale === "hi" && p.name_hi ? p.name_hi : p.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </section>

          <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm">
            {before > 0 ? (
              <div className="flex justify-between">
                <dt className="text-slate-600">{t("earlierDues")}</dt>
                <dd>{rupees(before)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt className="text-slate-600">{t("thisVisitTotal")}</dt>
              <dd>{rupees(visitDue + newTotal)}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>{t("toCollect")}</dt>
              <dd data-testid="to-collect">{rupees(Math.max(0, toCollect))}</dd>
            </div>
          </dl>

          {write ? (
            <section className="space-y-2">
              <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label={t("method")}>
                {METHODS.map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={method === m}
                    onClick={() => setMethod(m)}
                    className={`min-h-10 rounded-xl text-sm ${method === m ? "bg-brand-600 font-medium text-white" : "bg-white ring-1 ring-slate-300"}`}
                  >
                    {t(`methods.${m}`)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-700" htmlFor="checkout-amount">
                  {t("amountPaid")}
                </label>
                <Input
                  id="checkout-amount"
                  inputMode="decimal"
                  className="flex-1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              {data.patient.phone ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={sendReceipt}
                    onChange={(e) => setSendReceipt(e.target.checked)}
                  />
                  {t("sendReceipt")}
                </label>
              ) : null}
              {!linesOk ? <p className="text-sm text-amber-800">{t("enterAmounts")}</p> : null}
              <Button
                className="w-full"
                busy={busy}
                disabled={!linesOk || !valid(amount)}
                onClick={() => void finish(true)}
              >
                {t("takePayment", { amount: valid(amount) ? rupees(toPaise(amount)) : "" })}
              </Button>
              {lines.length ? (
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy || !linesOk}
                  onClick={() => void finish(false)}
                >
                  {t("payLater")}
                </Button>
              ) : null}
              <Button variant="ghost" className="w-full" onClick={() => onBookNext(data.patient)}>
                {t("bookNext")}
              </Button>
            </section>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

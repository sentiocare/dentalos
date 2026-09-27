"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ApiError, newIdempotencyKey } from "../lib/api";
import { useClinicConfig } from "../lib/data";
import { useSession } from "../lib/session";
import { formatRupees } from "../lib/time";
import { Button, Card, Field, Input, Select, Sheet, useToast } from "./ui";

type Method = "cash" | "upi" | "card" | "bank" | "gateway_link";

interface Entry {
  id: string;
  kind: "charge" | "payment" | "adjustment" | "refund";
  amountPaise: number;
  method: Method | null;
  description: string;
  reference: string | null;
  gstPaise: number;
  createdAt: string;
  createdBy: string | null;
  receipt: { id: string; number: string; cancelled: boolean } | null;
  invoice: { id: string; number: string } | null;
  reversed: boolean;
  reversesId: string | null;
}

interface Account {
  entries: Entry[];
  balancePaise: number;
  uninvoicedChargeIds: string[];
}

type Form =
  | { kind: "charge"; procedureId: string; amount: string; description: string; key: string }
  | { kind: "payment"; amount: string; method: Method; reference: string; sendReceipt: boolean; key: string }
  | { kind: "link"; amount: string; url: string | null }
  | { kind: "discount"; amount: string; reason: string }
  | { kind: "reverse"; entry: Entry; reason: string }
  | { kind: "refund"; entry: Entry; amount: string; method: Method; reason: string };

const rupeesToPaise = (s: string) => Math.round(Number(s.replace(/[,₹\s]/g, "")) * 100);
const validAmount = (s: string) => Number.isFinite(Number(s.replace(/[,₹\s]/g, ""))) && rupeesToPaise(s) > 0;

/** The patient's bill on the patient page (Build Prompt §5.10): charges, payments, receipts, invoices. */
export function PatientAccount({ patientId, hasPhone }: { patientId: string; hasPhone: boolean }) {
  const t = useTranslations("billing");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, can, openPdf } = useSession();
  const config = useClinicConfig();
  const toast = useToast();
  const [account, setAccount] = useState<Account | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const write = can("billing.write");
  const adjust = can("billing.adjust");
  const rupees = (p: number) => formatRupees(p, locale);

  const load = useCallback(async () => {
    setAccount(await api<Account>(`/v1/patients/${patientId}/account`));
  }, [api, patientId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  if (!can("billing.read")) return null;

  const submit = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const pdf = (path: string) => void openPdf(path).catch(() => toast(tc("error"), "error"));
  const balance = account?.balancePaise ?? 0;
  const procedures = (config.data?.procedures ?? []).filter((p) => p.active);

  const save = async () => {
    if (!form) return;
    const base = `/v1/patients/${patientId}`;
    switch (form.kind) {
      case "charge":
        if (!validAmount(form.amount) || !form.description.trim()) return;
        if (
          await submit(
            () =>
              api(`${base}/charges`, {
                method: "POST",
                body: {
                  amountPaise: rupeesToPaise(form.amount),
                  description: form.description.trim(),
                  procedureTypeId: form.procedureId || null,
                  clientKey: form.key,
                },
              }),
            t("chargeAdded"),
          )
        )
          setForm(null);
        return;
      case "payment":
        if (!validAmount(form.amount)) return;
        if (
          await submit(async () => {
            const res = await api<{ receiptNumber: string; receiptSent: boolean }>(`${base}/payments`, {
              method: "POST",
              body: {
                amountPaise: rupeesToPaise(form.amount),
                method: form.method,
                reference: form.reference.trim() || null,
                sendReceipt: form.sendReceipt && hasPhone,
                clientKey: form.key,
              },
            });
            toast(t("paid", { number: res.receiptNumber }));
          })
        )
          setForm(null);
        return;
      case "link":
        if (!validAmount(form.amount)) return;
        await submit(async () => {
          const res = await api<{ url: string }>(`${base}/payment-links`, {
            method: "POST",
            body: { amountPaise: rupeesToPaise(form.amount) },
          });
          setForm({ ...form, url: res.url });
        });
        return;
      case "discount":
        if (!validAmount(form.amount) || !form.reason.trim()) return;
        if (
          await submit(() =>
            api(`${base}/adjustments`, {
              method: "POST",
              body: { amountPaise: -rupeesToPaise(form.amount), description: form.reason.trim() },
            }),
          )
        )
          setForm(null);
        return;
      case "reverse":
        if (!form.reason.trim()) return;
        if (
          await submit(() =>
            api(`/v1/ledger/${form.entry.id}/reverse`, {
              method: "POST",
              body: { reason: form.reason.trim() },
            }),
          )
        )
          setForm(null);
        return;
      case "refund":
        if (!validAmount(form.amount) || !form.reason.trim()) return;
        if (
          await submit(() =>
            api(`/v1/ledger/${form.entry.id}/refund`, {
              method: "POST",
              body: {
                amountPaise: rupeesToPaise(form.amount),
                method: form.method,
                reason: form.reason.trim(),
              },
            }),
          )
        )
          setForm(null);
        return;
    }
  };

  const sign = (e: Entry) => (e.kind === "payment" ? -e.amountPaise : e.amountPaise);
  const methodLabel = (m: Method | null) => (m ? t(`methods.${m}`) : "");
  const balanceText =
    balance > 0
      ? t("due", { amount: rupees(balance) })
      : balance < 0
        ? t("advance", { amount: rupees(-balance) })
        : t("settled");

  return (
    <>
      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-semibold">{t("title")}</h2>
          <span
            data-testid="balance"
            className={`rounded-full px-2 py-0.5 text-sm font-medium ${balance > 0 ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}
          >
            {balanceText}
          </span>
        </div>
        {write ? (
          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                setForm({
                  kind: "charge",
                  procedureId: "",
                  amount: "",
                  description: "",
                  key: newIdempotencyKey(),
                })
              }
            >
              + {t("addCharge")}
            </Button>
            <Button
              onClick={() =>
                setForm({
                  kind: "payment",
                  amount: balance > 0 ? String(balance / 100) : "",
                  method: "cash",
                  reference: "",
                  sendReceipt: hasPhone,
                  key: newIdempotencyKey(),
                })
              }
            >
              {t("takePayment")}
            </Button>
            {balance > 0 && hasPhone ? (
              <Button
                variant="secondary"
                onClick={() => setForm({ kind: "link", amount: String(balance / 100), url: null })}
              >
                {t("paymentLink")}
              </Button>
            ) : null}
            {account?.uninvoicedChargeIds.length ? (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void submit(async () => {
                    const inv = await api<{ id: string; number: string }>(
                      `/v1/patients/${patientId}/invoices`,
                      {
                        method: "POST",
                        body: {},
                      },
                    );
                    toast(t("invoiceMade", { number: inv.number }));
                  })
                }
              >
                {t("makeInvoice")}
              </Button>
            ) : null}
            {adjust && balance > 0 ? (
              <Button
                variant="secondary"
                onClick={() => setForm({ kind: "discount", amount: "", reason: "" })}
              >
                {t("discount")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!account || account.entries.length === 0 ? (
          <p className="text-sm text-slate-500">{t("none")}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {[...account.entries].reverse().map((e) => (
              <li key={e.id} className={`py-2 ${e.reversed ? "text-slate-400 line-through" : ""}`}>
                <div className="flex justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{e.description}</span>
                    <span className="block text-xs text-slate-500">
                      {new Date(e.createdAt).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN")} ·{" "}
                      {t(`kinds.${e.kind}`)}
                      {e.method ? ` · ${methodLabel(e.method)}` : ""}
                      {e.reference ? ` · ${e.reference}` : ""}
                      {e.gstPaise ? ` · ${t("gstIncluded", { amount: rupees(e.gstPaise) })}` : ""}
                    </span>
                  </span>
                  <span className={`shrink-0 font-medium ${sign(e) < 0 ? "text-emerald-700" : ""}`}>
                    {sign(e) < 0 ? "−" : ""}
                    {rupees(Math.abs(sign(e)))}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs">
                  {e.receipt ? (
                    <button
                      className="text-brand-700 underline"
                      onClick={() => pdf(`/v1/receipts/${e.receipt!.id}/pdf`)}
                    >
                      {t("receipt")} {e.receipt.number}
                      {e.receipt.cancelled ? ` (${t("cancelled")})` : ""}
                    </button>
                  ) : null}
                  {e.receipt && write && hasPhone && !e.receipt.cancelled ? (
                    <button
                      className="text-brand-700 underline"
                      onClick={() =>
                        void submit(
                          () => api(`/v1/receipts/${e.receipt!.id}/send`, { method: "POST" }),
                          t("receiptSent"),
                        )
                      }
                    >
                      {t("sendReceipt")}
                    </button>
                  ) : null}
                  {e.invoice ? (
                    <button
                      className="text-brand-700 underline"
                      onClick={() => pdf(`/v1/invoices/${e.invoice!.id}/pdf`)}
                    >
                      {t("invoice")} {e.invoice.number}
                    </button>
                  ) : null}
                  {adjust &&
                  !e.reversed &&
                  !e.reversesId &&
                  e.kind !== "refund" &&
                  !(e.kind === "charge" && e.invoice) ? (
                    <button
                      className="text-slate-600 underline"
                      onClick={() => setForm({ kind: "reverse", entry: e, reason: "" })}
                    >
                      {t("reverse")}
                    </button>
                  ) : null}
                  {adjust && e.kind === "payment" && !e.reversed ? (
                    <button
                      className="text-slate-600 underline"
                      onClick={() =>
                        setForm({
                          kind: "refund",
                          entry: e,
                          amount: String(e.amountPaise / 100),
                          method: "cash",
                          reason: "",
                        })
                      }
                    >
                      {t("refund")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Sheet open={!!form} onClose={() => setForm(null)} title={form ? t(`sheets.${form.kind}`) : ""}>
        {form?.kind === "charge" ? (
          <div className="space-y-3">
            <Field label={t("treatment")}>
              {(id) => (
                <Select
                  id={id}
                  value={form.procedureId}
                  onChange={(e) => {
                    const p = procedures.find((x) => x.id === e.target.value);
                    const fixed = p && p.price_min_paise !== null && p.price_min_paise === p.price_max_paise;
                    setForm({
                      ...form,
                      procedureId: e.target.value,
                      description: p ? (locale === "hi" && p.name_hi ? p.name_hi : p.name) : form.description,
                      amount: fixed ? String(p!.price_min_paise! / 100) : form.amount,
                    });
                  }}
                >
                  <option value="">{t("other")}</option>
                  {procedures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {locale === "hi" && p.name_hi ? p.name_hi : p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("description")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              )}
            </Field>
            <Field label={t("amount")}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              )}
            </Field>
            <Button busy={busy} className="w-full" onClick={() => void save()}>
              {t("addCharge")}
            </Button>
          </div>
        ) : null}

        {form?.kind === "payment" ? (
          <div className="space-y-3">
            <Field label={t("amount")}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              )}
            </Field>
            <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={t("method")}>
              {(["cash", "upi", "card", "bank"] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={form.method === m}
                  className={`rounded-xl border px-2 py-2 text-sm ${form.method === m ? "border-brand-600 bg-brand-50 font-medium" : "border-slate-200"}`}
                  onClick={() => setForm({ ...form, method: m })}
                >
                  {methodLabel(m)}
                </button>
              ))}
            </div>
            {form.method !== "cash" ? (
              <Field label={t("reference")}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.reference}
                    onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  />
                )}
              </Field>
            ) : null}
            {hasPhone ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={form.sendReceipt}
                  onChange={(e) => setForm({ ...form, sendReceipt: e.target.checked })}
                />
                {t("sendReceiptWhatsApp")}
              </label>
            ) : null}
            <Button busy={busy} className="w-full" onClick={() => void save()}>
              {t("savePayment")}
            </Button>
          </div>
        ) : null}

        {form?.kind === "link" ? (
          <div className="space-y-3">
            {form.url ? (
              <>
                <p className="text-sm">{t("linkReady")}</p>
                <Input readOnly value={form.url} onFocus={(e) => e.target.select()} />
                <Button
                  className="w-full"
                  onClick={() =>
                    void navigator.clipboard?.writeText(form.url!).then(() => toast(t("copied")))
                  }
                >
                  {t("copy")}
                </Button>
              </>
            ) : (
              <>
                <Field label={t("amount")}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    />
                  )}
                </Field>
                <p className="text-xs text-slate-500">{t("linkHint")}</p>
                <Button busy={busy} className="w-full" onClick={() => void save()}>
                  {t("makeLink")}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {form?.kind === "discount" || form?.kind === "reverse" || form?.kind === "refund" ? (
          <div className="space-y-3">
            {form.kind === "reverse" ? (
              <p className="text-sm">
                {form.entry.description} · {rupees(form.entry.amountPaise)}
              </p>
            ) : (
              <Field label={t("amount")}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                )}
              </Field>
            )}
            {form.kind === "refund" ? (
              <Field label={t("method")}>
                {(id) => (
                  <Select
                    id={id}
                    value={form.method}
                    onChange={(e) => setForm({ ...form, method: e.target.value as Method })}
                  >
                    {(["cash", "upi", "card", "bank"] as const).map((m) => (
                      <option key={m} value={m}>
                        {methodLabel(m)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field label={t("reason")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              )}
            </Field>
            <Button busy={busy} className="w-full" onClick={() => void save()}>
              {tc("save")}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

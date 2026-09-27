"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, Input, Select, Sheet, Spinner, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";
import { formatRupees } from "../../../lib/time";

type Stage =
  "new" | "contacted" | "engaged" | "qualified" | "booked" | "visited" | "won" | "lost" | "unresponsive";
interface Lead {
  id: string;
  source: string;
  campaign: string | null;
  name: string | null;
  phone: string;
  need: string | null;
  timing: string | null;
  score: "hot" | "warm" | "cold";
  stage: Stage;
  lost_reason: string | null;
  created_at: string;
  first_contact_at: string | null;
  call_due_at: string | null;
  conversation_id: string | null;
  won_value_paise: number | null;
}
interface Detail {
  lead: Lead & {
    answers: Record<string, string>;
    notes: string | null;
    email: string | null;
    ad: string | null;
  };
  activities: { kind: string; detail: Record<string, unknown>; at: string }[];
  conversationId: string | null;
}
interface Funnel {
  totals: {
    leads: number;
    contacted: number;
    booked: number;
    visited: number;
    won: number;
    revenuePaise: number | null;
    within5min: number;
  };
}

const TABS = ["call", "open", "booked", "visited", "won", "lost"] as const;
type Tab = (typeof TABS)[number];
const SCORE_STYLE = {
  hot: "bg-red-100 text-red-800",
  warm: "bg-amber-100 text-amber-800",
  cold: "bg-slate-100 text-slate-600",
};

/**
 * Leads (Phase 6). The assistant answers every lead within seconds and books consultations; this page is
 * where people take over: the leads to call now come first, with everything the lead said.
 */
export default function LeadsPage() {
  const t = useTranslations("leads");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("call");
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", source: "phone", need: "", notes: "" });
  const [outcome, setOutcome] = useState<{ kind: string; note: string; when: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const write = can("patients.write");

  const load = useCallback(async () => {
    setRows(await api<Lead[]>(`/v1/leads?stage=${tab}`));
  }, [api, tab]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    void api<Funnel>(
      `/v1/leads/funnel?from=${encodeURIComponent(from)}&to=${encodeURIComponent(now.toISOString())}`,
    )
      .then(setFunnel)
      .catch(() => {});
  }, [api]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const openLead = (id: string) => void run(async () => setOpen(await api<Detail>(`/v1/leads/${id}`)));
  const ago = (iso: string) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    return min < 60
      ? t("minAgo", { n: min })
      : min < 1440
        ? t("hoursAgo", { n: Math.round(min / 60) })
        : t("daysAgo", { n: Math.round(min / 1440) });
  };
  const saveOutcome = async () => {
    if (!open || !outcome) return;
    const ok = await run(
      () =>
        api(`/v1/leads/${open.lead.id}/outcome`, {
          method: "POST",
          body: {
            outcome: outcome.kind,
            note: outcome.note.trim() || null,
            callbackAt:
              outcome.kind === "callback" && outcome.when ? new Date(outcome.when).toISOString() : null,
          },
        }),
      tc("saved"),
    );
    if (ok) {
      setOutcome(null);
      setOpen(await api<Detail>(`/v1/leads/${open.lead.id}`));
      await load();
    }
  };

  const f = funnel?.totals;
  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        {write ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            + {t("add")}
          </Button>
        ) : null}
      </div>

      {f ? (
        <div className="grid grid-cols-4 gap-2 text-center" data-testid="lead-funnel">
          {[
            [t("thisMonth"), f.leads],
            [t("fast"), f.leads ? `${Math.round((f.within5min * 100) / f.leads)}%` : "—"],
            [t("booked"), f.booked],
            [
              t("won"),
              f.revenuePaise !== null ? `${f.won} · ${formatRupees(f.revenuePaise, locale)}` : f.won,
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-2xl border border-slate-200 bg-white p-2">
              <p className="text-[11px] text-slate-500">{label}</p>
              <p className="text-sm font-semibold">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((k) => (
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

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState>{t(`empty.${tab}`)}</EmptyState>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white"
          data-testid="leads"
        >
          {rows.map((l) => {
            const overdue = l.call_due_at && new Date(l.call_due_at).getTime() < Date.now();
            return (
              <li key={l.id}>
                <button
                  className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
                  onClick={() => openLead(l.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{l.name ?? displayPhone(l.phone)}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {t(`sources.${l.source}`)}
                      {l.campaign ? ` · ${l.campaign}` : ""}
                      {l.need ? ` · ${t(`needs.${l.need}`)}` : ""}
                      {l.timing ? ` · ${t(`timings.${l.timing}`)}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${SCORE_STYLE[l.score]}`}>
                      {t(`scores.${l.score}`)}
                    </span>
                    <span className={`text-xs ${overdue ? "font-medium text-red-700" : "text-slate-500"}`}>
                      {l.call_due_at ? (overdue ? t("callOverdue") : t("callDue")) : ago(l.created_at)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={!!open}
        onClose={() => {
          setOpen(null);
          setOutcome(null);
        }}
        title={open?.lead.name ?? open?.lead.phone ?? ""}
      >
        {open ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <a
                href={`tel:${open.lead.phone}`}
                className="inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-4 font-medium text-white"
              >
                {t("call")} {displayPhone(open.lead.phone)}
              </a>
              {open.conversationId ? (
                <Link
                  href={`/inbox/${open.conversationId}`}
                  className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-4"
                >
                  {t("chat")}
                </Link>
              ) : null}
            </div>
            <p>
              <span className={`rounded-full px-2 py-0.5 text-xs ${SCORE_STYLE[open.lead.score]}`}>
                {t(`scores.${open.lead.score}`)}
              </span>{" "}
              {t(`stages.${open.lead.stage}`)}
              {open.lead.lost_reason ? ` · ${open.lead.lost_reason}` : ""}
            </p>
            <dl className="space-y-1">
              {[
                [
                  t("source"),
                  `${t(`sources.${open.lead.source}`)}${open.lead.campaign ? ` · ${open.lead.campaign}` : ""}`,
                ],
                open.lead.need ? [t("wants"), t(`needs.${open.lead.need}`)] : null,
                open.lead.timing ? [t("when"), t(`timings.${open.lead.timing}`)] : null,
                ...Object.entries(open.lead.answers ?? {})
                  .filter(([k]) => !["full_name", "phone_number"].includes(k))
                  .map(([k, v]) => [k.replace(/_/g, " "), v]),
                open.lead.notes ? [t("notes"), open.lead.notes] : null,
              ]
                .filter((x): x is string[] => !!x)
                .map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="w-28 shrink-0 text-slate-500">{k}</dt>
                    <dd className="whitespace-pre-line">{v}</dd>
                  </div>
                ))}
            </dl>

            {write && ["new", "contacted", "engaged", "qualified"].includes(open.lead.stage) ? (
              outcome ? (
                <div className="space-y-2 rounded-xl bg-slate-50 p-3">
                  {outcome.kind === "callback" ? (
                    <Field label={t("callbackAt")}>
                      {(id) => (
                        <Input
                          id={id}
                          type="datetime-local"
                          value={outcome.when}
                          onChange={(e) => setOutcome({ ...outcome, when: e.target.value })}
                        />
                      )}
                    </Field>
                  ) : null}
                  <Field label={outcome.kind === "not_interested" ? t("reason") : t("note")}>
                    {(id) => (
                      <Input
                        id={id}
                        value={outcome.note}
                        onChange={(e) => setOutcome({ ...outcome, note: e.target.value })}
                      />
                    )}
                  </Field>
                  <Button busy={busy} className="w-full" onClick={() => void saveOutcome()}>
                    {tc("save")}
                  </Button>
                </div>
              ) : (
                <div>
                  <p className="mb-1 font-medium">{t("afterCall")}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(["booked", "callback", "no_answer", "not_interested", "wrong_number"] as const).map(
                      (k) => (
                        <Button
                          key={k}
                          variant={k === "booked" ? "primary" : "secondary"}
                          onClick={() => setOutcome({ kind: k, note: "", when: "" })}
                        >
                          {t(`outcomes.${k}`)}
                        </Button>
                      ),
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{t("bookedHint")}</p>
                </div>
              )
            ) : null}
            {write && ["lost", "unresponsive"].includes(open.lead.stage) ? (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/v1/leads/${open.lead.id}/reopen`, { method: "POST" });
                    setOpen(await api<Detail>(`/v1/leads/${open.lead.id}`));
                    await load();
                  })
                }
              >
                {t("reopen")}
              </Button>
            ) : null}

            <div>
              <p className="mb-1 font-medium">{t("timeline")}</p>
              <ul className="space-y-1 text-xs text-slate-600">
                {open.activities.map((a, i) => (
                  <li key={i}>
                    {new Date(a.at).toLocaleString(locale === "hi" ? "hi-IN" : "en-IN", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}{" "}
                    · {t(`activity.${a.kind}`)}
                    {typeof a.detail.outcome === "string" ? ` (${t(`outcomes.${a.detail.outcome}`)})` : ""}
                    {typeof a.detail.note === "string" && a.detail.note ? `: ${a.detail.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={adding} onClose={() => setAdding(false)} title={t("add")}>
        <div className="space-y-3">
          <Field label={t("name")}>
            {(id) => (
              <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            )}
          </Field>
          <Field label={t("phone")}>
            {(id) => (
              <Input
                id={id}
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("source")}>
            {(id) => (
              <Select
                id={id}
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              >
                {["phone", "walk_in", "website", "practo", "justdial", "referral", "other"].map((s) => (
                  <option key={s} value={s}>
                    {t(`sources.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("wants")}>
            {(id) => (
              <Select id={id} value={form.need} onChange={(e) => setForm({ ...form, need: e.target.value })}>
                <option value="">—</option>
                {["pain", "implant", "braces", "rct", "cleaning", "cosmetic", "other"].map((s) => (
                  <option key={s} value={s}>
                    {t(`needs.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("notes")}>
            {(id) => (
              <Input
                id={id}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            )}
          </Field>
          <p className="text-xs text-slate-500">{t("addHint")}</p>
          <Button
            busy={busy}
            className="w-full"
            onClick={() =>
              void run(async () => {
                await api("/v1/leads", {
                  method: "POST",
                  body: {
                    name: form.name,
                    phone: form.phone,
                    source: form.source,
                    need: form.need || null,
                    notes: form.notes || null,
                  },
                });
                setAdding(false);
                setForm({ name: "", phone: "", source: "phone", need: "", notes: "" });
                await load();
              }, t("added"))
            }
          >
            {t("add")}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import { formatRupees, todayIn } from "../lib/time";
import { Button, Card, Field, Input, Select, Sheet, useToast } from "./ui";

interface Step {
  id: string;
  seq: number;
  procedureTypeId: string;
  procedure: string;
  tooth: string | null;
  status: "pending" | "scheduled" | "done" | "missed" | "skipped";
  expectedFrom: string | null;
  expectedTo: string | null;
  valuePaise: number;
  appointmentStartsAt: string | null;
}

interface Plan {
  id: string;
  title: string;
  status: "proposed" | "accepted" | "in_progress" | "completed" | "abandoned";
  teeth: string[];
  totalPaise: number;
  donePaise: number;
  steps: Step[];
}

interface Estimate {
  id: string;
  total_paise: number;
  status: "draft" | "sent" | "accepted" | "declined" | "expired";
  valid_until: string;
  items: { label: string; qty: number; amount_paise: number }[];
}

interface Template {
  id: string;
  code: string;
  name: string;
  name_hi: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  proposed: "bg-slate-100 text-slate-700",
  accepted: "bg-sky-100 text-sky-800",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  abandoned: "bg-slate-100 text-slate-500 line-through",
  pending: "bg-slate-100 text-slate-700",
  scheduled: "bg-sky-100 text-sky-800",
  done: "bg-emerald-100 text-emerald-800",
  missed: "bg-red-100 text-red-800",
  skipped: "bg-slate-100 text-slate-500",
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-sky-100 text-sky-800",
  declined: "bg-red-100 text-red-800",
  expired: "bg-slate-100 text-slate-500",
};

/** Treatment plans and estimates on the patient page (Build Prompt §5.4). */
export function TreatmentPlans({
  patientId,
  timezone,
  onBookSitting,
}: {
  patientId: string;
  timezone: string;
  onBookSitting: (step: { procedureTypeId: string; treatmentStepId: string; date: string }) => void;
}) {
  const t = useTranslations("plans");
  const te = useTranslations("estimates");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ templateId: "", teeth: "", startDate: "", accepted: true });
  const writable = can("patients.write");
  const money = can("reports.revenue");
  const today = todayIn(timezone);

  const load = useCallback(async () => {
    const [p, e] = await Promise.all([
      api<Plan[]>(`/v1/patients/${patientId}/plans`),
      api<Estimate[]>(`/v1/patients/${patientId}/estimates`),
    ]);
    setPlans(p);
    setEstimates(e);
  }, [api, patientId]);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const act = async (path: string, body?: unknown, method = "POST") => {
    try {
      const res = await api<Record<string, unknown>>(path, { method, body });
      await load();
      return res;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return null;
    }
  };

  const openCreate = async () => {
    if (templates.length === 0) setTemplates(await api<Template[]>("/v1/treatment-templates"));
    setForm({ templateId: "", teeth: "", startDate: today, accepted: true });
    setCreating(true);
  };

  const nextStep = (plan: Plan) =>
    ["proposed", "accepted", "in_progress"].includes(plan.status)
      ? plan.steps.find((s) => s.status === "pending" || s.status === "missed")
      : undefined;

  return (
    <>
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">{t("title")}</h2>
          {writable ? (
            <button className="text-sm text-brand-700 underline" onClick={() => void openCreate()}>
              + {t("new")}
            </button>
          ) : null}
        </div>
        {plans.length === 0 ? <p className="text-sm text-slate-500">{t("none")}</p> : null}
        <div className="space-y-4">
          {plans.map((plan) => {
            const next = nextStep(plan);
            const done = plan.steps.filter((s) => s.status === "done").length;
            return (
              <div key={plan.id} className="rounded-xl border border-slate-200 p-3" data-testid="plan">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {plan.title}
                      {plan.teeth.length ? (
                        <span className="text-slate-500"> · {plan.teeth.join(", ")}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t("done", { done, total: plan.steps.length })}
                      {money
                        ? ` · ${formatRupees(plan.donePaise, locale)} / ${formatRupees(plan.totalPaise, locale)}`
                        : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[plan.status]}`}>
                    {t(`status.${plan.status}`)}
                  </span>
                </div>
                <ol className="mt-2 space-y-1 text-sm">
                  {plan.steps.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <span className={s.status === "skipped" ? "text-slate-400 line-through" : ""}>
                        {s.seq}. {s.procedure}
                        {s.expectedFrom && s.status !== "done" ? (
                          <span className="text-xs text-slate-500">
                            {" "}
                            ·{" "}
                            {t("window", {
                              from: s.expectedFrom.slice(5),
                              to: (s.expectedTo ?? s.expectedFrom).slice(5),
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {money ? (
                          <span className="text-xs text-slate-500">{formatRupees(s.valuePaise, locale)}</span>
                        ) : null}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_STYLE[s.status]}`}>
                          {t(`stepStatus.${s.status}`)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
                {writable ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {next && can("appointments.write") ? (
                      <Button
                        className="min-h-9"
                        onClick={() =>
                          onBookSitting({
                            procedureTypeId: next.procedureTypeId,
                            treatmentStepId: next.id,
                            date: next.expectedFrom && next.expectedFrom > today ? next.expectedFrom : today,
                          })
                        }
                      >
                        {t("bookSitting")}: {next.procedure}
                      </Button>
                    ) : null}
                    {next ? (
                      <Button
                        variant="secondary"
                        className="min-h-9"
                        onClick={() => void act(`/v1/plan-steps/${next.id}`, { skip: true }, "PATCH")}
                      >
                        {t("skip")}
                      </Button>
                    ) : null}
                    {plan.status === "proposed" ? (
                      <Button
                        variant="secondary"
                        className="min-h-9"
                        onClick={() => void act(`/v1/plans/${plan.id}/accept`)}
                      >
                        {t("accept")}
                      </Button>
                    ) : null}
                    {["proposed", "accepted", "in_progress"].includes(plan.status) ? (
                      <>
                        <Button
                          variant="secondary"
                          className="min-h-9"
                          onClick={() => void act(`/v1/plans/${plan.id}/estimate`)}
                        >
                          {t("estimate")}
                        </Button>
                        <Button
                          variant="secondary"
                          className="min-h-9"
                          onClick={() => {
                            const reason = window.prompt(t("abandonReason")) ?? undefined;
                            void act(`/v1/plans/${plan.id}/abandon`, { reason });
                          }}
                        >
                          {t("abandon")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{te("title")}</h2>
        {estimates.length === 0 ? <p className="text-sm text-slate-500">{te("none")}</p> : null}
        <ul className="divide-y divide-slate-100 text-sm">
          {estimates.map((e) => (
            <li key={e.id} className="space-y-1 py-2" data-testid="estimate">
              <div className="flex items-center justify-between gap-2">
                <span>{e.items.map((i) => `${i.label}${i.qty > 1 ? ` × ${i.qty}` : ""}`).join(", ")}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[e.status]}`}>
                  {te(`status.${e.status}`)}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                {formatRupees(e.total_paise, locale)} · {te("validUntil", { date: e.valid_until })}
              </p>
              {writable ? (
                <div className="flex flex-wrap gap-2">
                  {e.status === "draft" ? (
                    <Button
                      className="min-h-9"
                      onClick={async () => (await act(`/v1/estimates/${e.id}/send`)) && toast(te("sent"))}
                    >
                      {te("send")}
                    </Button>
                  ) : null}
                  {e.status === "sent" ? (
                    <>
                      <Button
                        variant="secondary"
                        className="min-h-9"
                        onClick={() => void act(`/v1/estimates/${e.id}/decision`, { decision: "accepted" })}
                      >
                        {te("markAccepted")}
                      </Button>
                      <Button
                        variant="secondary"
                        className="min-h-9"
                        onClick={() => void act(`/v1/estimates/${e.id}/decision`, { decision: "declined" })}
                      >
                        {te("markDeclined")}
                      </Button>
                      <Button
                        variant="secondary"
                        className="min-h-9"
                        onClick={async () => {
                          const res = await act(`/v1/estimates/${e.id}/pdf`, undefined, "GET");
                          if (res?.url) window.open(String(res.url), "_blank", "noopener");
                        }}
                      >
                        {te("viewPdf")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Sheet open={creating} onClose={() => setCreating(false)} title={t("new")}>
        <div className="space-y-3">
          <Field label={t("template")}>
            {(id) => (
              <Select
                id={id}
                value={form.templateId}
                onChange={(e) => setForm({ ...form, templateId: e.target.value })}
              >
                <option value="">—</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {locale === "hi" && tpl.name_hi ? tpl.name_hi : tpl.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("teeth")}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={form.teeth}
                onChange={(e) => setForm({ ...form, teeth: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("startDate")}>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={form.accepted}
              onChange={(e) => setForm({ ...form, accepted: e.target.checked })}
            />
            {t("acceptedNow")}
          </label>
          <Button
            className="w-full"
            disabled={!form.templateId}
            onClick={async () => {
              const teeth = form.teeth
                .split(/[\s,]+/)
                .map((x) => x.trim())
                .filter((x) => /^[1-8][1-8]$/.test(x));
              const ok = await act(`/v1/patients/${patientId}/plans`, {
                templateId: form.templateId,
                teeth,
                startDate: form.startDate || undefined,
                status: form.accepted ? "accepted" : "proposed",
              });
              if (ok) setCreating(false);
            }}
          >
            {t("create")}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, Input, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";

interface Campaign {
  id: string;
  name: string;
  offer_text: string;
  status: "draft" | "awaiting_owner" | "approved" | "running" | "done" | "cancelled";
  stats: { queued?: number };
  audience: { inactiveMonths?: number };
}

/** Reactivation campaigns (Build Prompt §7.7): factual wording, marketing consent only, owner approval. */
export default function CampaignsPage() {
  const t = useTranslations("campaigns");
  const tc = useTranslations("common");
  const { api, clinic } = useSession();
  const toast = useToast();
  const [list, setList] = useState<Campaign[]>([]);
  const [form, setForm] = useState({ name: "", inactiveMonths: 12, offerText: "" });
  const [problems, setProblems] = useState<string[]>([]);
  const [audience, setAudience] = useState<{ eligible: number; noConsent: number; optedOut: number } | null>(
    null,
  );
  const isOwner = clinic?.role === "owner";

  const load = useCallback(
    () =>
      api<Campaign[]>("/v1/campaigns")
        .then(setList)
        .catch(() => {}),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<{ eligible: number; noConsent: number; optedOut: number }>(
      `/v1/campaigns/audience?inactiveMonths=${form.inactiveMonths}`,
    )
      .then(setAudience)
      .catch(() => {});
  }, [api, form.inactiveMonths]);
  useEffect(() => {
    if (!form.offerText.trim()) return setProblems([]);
    const timer = setTimeout(() => {
      void api<{ problems: string[] }>("/v1/campaigns/check-text", {
        method: "POST",
        body: { text: form.offerText },
      })
        .then((r) => setProblems(r.problems))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [api, form.offerText]);

  const act = async (path: string, body?: unknown) => {
    try {
      await api(path, { method: "POST", body: body ?? {} });
      await load();
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return false;
    }
  };

  return (
    <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-4 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">{t("new")}</h2>
        <Field label={t("name")}>
          {(id) => (
            <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          )}
        </Field>
        <Field label={t("inactiveMonths")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={3}
              max={60}
              value={form.inactiveMonths}
              onChange={(e) => setForm({ ...form, inactiveMonths: Number(e.target.value) || 12 })}
            />
          )}
        </Field>
        <Field label={t("message")}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              maxLength={300}
              value={form.offerText}
              onChange={(e) => setForm({ ...form, offerText: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-base"
            />
          )}
        </Field>
        {problems.length ? (
          <p className="text-sm text-red-700">{t("problems", { list: problems.join(", ") })}</p>
        ) : null}
        {audience ? <p className="text-xs text-slate-500">{t("audience", audience)}</p> : null}
        <Button
          disabled={!form.name.trim() || !form.offerText.trim() || problems.length > 0}
          onClick={async () => {
            try {
              await api("/v1/campaigns", { method: "POST", body: form });
              setForm({ name: "", inactiveMonths: 12, offerText: "" });
              await load();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : tc("error"), "error");
            }
          }}
        >
          {t("create")}
        </Button>
      </section>

      {list.length === 0 ? <EmptyState>{t("empty")}</EmptyState> : null}
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.id} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{c.name}</p>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t(`status.${c.status}`)}</span>
            </div>
            <p className="text-sm text-slate-600">{c.offer_text}</p>
            {c.status === "done" ? (
              <p className="text-xs text-slate-500">{t("stats", { queued: c.stats.queued ?? 0 })}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {c.status === "draft" ? (
                <Button className="min-h-9" onClick={() => void act(`/v1/campaigns/${c.id}/submit`)}>
                  {t("submit")}
                </Button>
              ) : null}
              {c.status === "awaiting_owner" && isOwner ? (
                <Button className="min-h-9" onClick={() => void act(`/v1/campaigns/${c.id}/approve`)}>
                  {t("approve")}
                </Button>
              ) : null}
              {c.status === "approved" && isOwner ? (
                <Button className="min-h-9" onClick={() => void act(`/v1/campaigns/${c.id}/run`)}>
                  {t("run")}
                </Button>
              ) : null}
              {["draft", "awaiting_owner", "approved"].includes(c.status) ? (
                <Button
                  variant="secondary"
                  className="min-h-9"
                  onClick={() => void act(`/v1/campaigns/${c.id}/cancel`)}
                >
                  {t("cancel")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

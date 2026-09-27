"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Spinner, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";

interface Run {
  id: string;
  kind: string;
  status: string;
  next_at: string;
  stop_reason: string | null;
  patient_id: string;
  patient_name: string;
  actions: number;
}

export default function FollowupsPage() {
  const t = useTranslations("followups");
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<"active" | "finished">("active");
  const [rows, setRows] = useState<Run[] | null>(null);
  const load = useCallback(
    () =>
      api<Run[]>(`/v1/followups?status=${status}`)
        .then(setRows)
        .catch(() => {}),
    [api, status],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex gap-2">
        {(["active", "finished"] as const).map((s) => (
          <button
            key={s}
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className="rounded-full border border-slate-300 px-3 py-1.5 text-sm aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-pressed:text-brand-700"
          >
            {t(s)}
          </button>
        ))}
      </div>
      {!rows ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-500 uppercase">{t(`kinds.${r.kind}`)}</p>
                <Link href={`/patients/${r.patient_id}`} className="font-medium hover:underline">
                  {r.patient_name}
                </Link>
                <p className="text-xs text-slate-500">
                  {r.status === "active" ? t("nextAt", { when: when(r.next_at) }) : t(`status.${r.status}`)}
                </p>
              </div>
              {r.status === "active" && can("appointments.write") ? (
                <Button
                  variant="secondary"
                  className="min-h-9 shrink-0"
                  onClick={async () => {
                    try {
                      await api(`/v1/followups/${r.id}/stop`, { method: "POST", body: {} });
                      await load();
                    } catch (e) {
                      toast(e instanceof ApiError ? e.message : "Error", "error");
                    }
                  }}
                >
                  {t("stop")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

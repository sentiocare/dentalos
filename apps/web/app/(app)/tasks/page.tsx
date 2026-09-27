"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Spinner } from "../../../components/ui";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";

interface Task {
  id: string;
  kind: string;
  priority: "critical" | "high" | "normal" | "low";
  title: string;
  detail: string | null;
  created_at: string;
  conversation_id: string | null;
  patient_id: string | null;
  patient_phone: string | null;
}

const PRIORITY_STYLE = {
  critical: "border-red-300 bg-red-50",
  high: "border-amber-300 bg-amber-50",
  normal: "border-slate-200 bg-white",
  low: "border-slate-200 bg-white",
};

export default function TasksPage() {
  const t = useTranslations("tasks");
  const locale = useLocale();
  const { api, can } = useSession();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const load = useCallback(
    () =>
      api<Task[]>("/v1/tasks")
        .then(setTasks)
        .catch(() => {}),
    [api],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!tasks) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const fmt = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      {tasks.length === 0 ? <EmptyState>{t("empty")}</EmptyState> : null}
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className={`rounded-2xl border p-3 ${PRIORITY_STYLE[task.priority]}`}>
            <p className="text-xs font-semibold text-slate-500 uppercase">{t(`kinds.${task.kind}`)}</p>
            <p className="font-medium">{task.title}</p>
            {task.detail ? (
              <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{task.detail}</p>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">{fmt.format(new Date(task.created_at))}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {task.patient_phone ? (
                <a
                  href={`tel:${task.patient_phone}`}
                  className="inline-flex min-h-9 items-center rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  📞 {t("call")} {displayPhone(task.patient_phone)}
                </a>
              ) : null}
              {task.conversation_id ? (
                <Link
                  href={`/inbox/${task.conversation_id}`}
                  className="inline-flex min-h-9 items-center rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  {t("openChat")}
                </Link>
              ) : null}
              {can("appointments.write") ? (
                <Button
                  className="min-h-9"
                  onClick={() => void api(`/v1/tasks/${task.id}/done`, { method: "POST" }).then(load)}
                >
                  {t("done")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

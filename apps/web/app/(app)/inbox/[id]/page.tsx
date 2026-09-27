"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner, useToast } from "../../../../components/ui";
import { ApiError } from "../../../../lib/api";
import { displayPhone } from "../../../../lib/format";
import { useSession } from "../../../../lib/session";

interface Message {
  id: string;
  direction: "in" | "out";
  author: "patient" | "bot" | "staff" | "system";
  kind: string;
  body: string | null;
  payload: { buttons?: { title: string }[] } & Record<string, unknown>;
  status: string;
  error: string | null;
  created_at: string;
}

interface Thread {
  conversation: {
    id: string;
    phone: string;
    mode: "bot" | "human";
    patient_id: string | null;
    patient_name: string | null;
    windowOpen: boolean;
    taken_over_by_name: string | null;
  };
  messages: Message[];
  tasks: { id: string; kind: string; priority: string; title: string; detail: string | null }[];
}

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("inbox");
  const tt = useTranslations("tasks");
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setThread(await api<Thread>(`/v1/inbox/${id}`));
    } catch {
      // keep the last copy
    }
  }, [api, id]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 8_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length]);

  if (!thread) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const c = thread.conversation;
  const editable = can("appointments.write");
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await api(path, { method: "POST", body });
      await load();
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Error", "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));

  return (
    <div className="mx-auto flex h-[calc(100dvh-7.5rem)] max-w-2xl flex-col md:h-[calc(100dvh-5rem)] lg:h-full lg:max-w-none">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <div className="min-w-0">
          <Link href="/inbox" className="text-xs text-brand-700 lg:hidden">
            ‹ {t("title")}
          </Link>
          <p className="truncate font-semibold">
            {c.patient_id ? (
              <Link href={`/patients/${c.patient_id}`} className="underline-offset-2 hover:underline">
                {c.patient_name}
              </Link>
            ) : (
              displayPhone(c.phone)
            )}
          </p>
          <a href={`tel:${c.phone}`} className="text-xs text-slate-500 underline">
            {displayPhone(c.phone)}
          </a>
        </div>
        {editable ? (
          c.mode === "bot" ? (
            <Button variant="secondary" busy={busy} onClick={() => void act(`/v1/inbox/${id}/takeover`)}>
              {t("takeOver")}
            </Button>
          ) : (
            <Button variant="secondary" busy={busy} onClick={() => void act(`/v1/inbox/${id}/release`)}>
              {t("release")}
            </Button>
          )
        ) : null}
      </div>

      {thread.tasks.length ? (
        <div className="space-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm">
          {thread.tasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-2">
              <span className={task.priority === "critical" ? "font-semibold text-red-700" : ""}>
                {tt(`kinds.${task.kind}`)}: {task.title}
              </span>
              {editable ? (
                <button
                  className="shrink-0 text-brand-700 underline"
                  onClick={() => void act(`/v1/tasks/${task.id}/done`)}
                >
                  {tt("done")}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex-1 space-y-2 overflow-y-auto bg-slate-100 px-3 py-3">
        {thread.messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "in" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.direction === "in" ? "bg-white" : m.author === "staff" ? "bg-violet-100" : "bg-emerald-50"} ${m.status === "blocked" || m.status === "failed" ? "opacity-60" : ""}`}
            >
              {m.direction === "out" ? (
                <p className="mb-0.5 text-[10px] font-medium text-slate-500 uppercase">
                  {t(m.author === "staff" ? "you" : m.author === "bot" ? "bot" : "system")}
                </p>
              ) : null}
              {m.kind === "audio" ? (
                <p className="text-xs text-slate-500">
                  🎤 {t("voiceNote")}
                  {m.body ? ` · ${t("transcript")}:` : ""}
                </p>
              ) : null}
              <p className="whitespace-pre-line">{m.body ?? `[${m.kind}]`}</p>
              {m.payload.buttons?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.payload.buttons.map((b, i) => (
                    <span
                      key={i}
                      className="rounded-full border border-emerald-300 px-2 py-0.5 text-xs text-emerald-800"
                    >
                      {b.title}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="mt-1 text-right text-[10px] text-slate-400">
                {time(m.created_at)}
                {m.status === "blocked"
                  ? ` · ${t("blocked")} (${m.error})`
                  : m.status === "failed"
                    ? ` · ${t("failed")}`
                    : m.direction === "out"
                      ? ` · ${m.status}`
                      : ""}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {editable ? (
        <div className="space-y-2 border-t border-slate-200 bg-white p-3">
          {!c.windowOpen ? (
            <p className="text-xs text-amber-800">{t("windowClosed")}</p>
          ) : c.mode === "human" ? (
            <p className="text-xs text-violet-800">{t("takenOverNote")}</p>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              if (await act(`/v1/inbox/${id}/reply`, { text })) setText("");
            }}
          >
            <textarea
              rows={1}
              value={text}
              disabled={!c.windowOpen}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("reply")}
              className="min-h-11 flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-base"
            />
            <Button type="submit" busy={busy} disabled={!c.windowOpen || !text.trim()}>
              {t("send")}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

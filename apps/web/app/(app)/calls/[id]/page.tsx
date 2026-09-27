"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, Spinner, useToast } from "../../../../components/ui";
import { ApiError } from "../../../../lib/api";
import { displayPhone } from "../../../../lib/format";
import { useSession } from "../../../../lib/session";

interface Detail {
  call: {
    id: string;
    started_at: string;
    from_phone: string | null;
    route: string | null;
    outcome: string | null;
    summary: string | null;
    duration_sec: number | null;
    patient_id: string | null;
    patient_name: string | null;
    test_result: "pass" | "fail" | null;
    test_notes: string | null;
    usage: { stt_ms?: number; tts_chars?: number };
    latency: { p50?: number; p95?: number; max?: number };
  };
  turns: {
    seq: number;
    speaker: "caller" | "assistant" | "system";
    text: string;
    latency_ms: number | null;
    flags: string[];
  }[];
  tasks: { id: string; kind: string; priority: string; title: string; status: string }[];
  recordingUrl: string | null;
}

export default function CallPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("calls");
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [result, setResult] = useState<"pass" | "fail" | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await api<Detail>(`/v1/calls/${id}`);
    setData(d);
    setResult(d.call.test_result);
    setNotes(d.call.test_notes ?? "");
  }, [api, id]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  if (!data) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const c = data.call;
  const when = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(c.started_at));

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <div>
        <Link href="/calls" className="text-xs text-brand-700">
          ‹ {t("title")}
        </Link>
        <h1 className="text-xl font-semibold">
          {c.patient_id ? (
            <Link href={`/patients/${c.patient_id}`} className="hover:underline">
              {c.patient_name}
            </Link>
          ) : c.from_phone ? (
            displayPhone(c.from_phone)
          ) : (
            t("unknownCaller")
          )}
        </h1>
        <p className="text-sm text-slate-600">
          {when}
          {c.duration_sec ? ` · ${t("duration", { sec: c.duration_sec })}` : ""}
          {c.outcome ? ` · ${t(`outcomes.${c.outcome}`)}` : ""}
        </p>
        {c.from_phone ? (
          <a href={`tel:${c.from_phone}`} className="text-sm text-brand-700 underline">
            📞 {displayPhone(c.from_phone)}
          </a>
        ) : null}
      </div>

      {c.summary ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-500">{t("summary")}</h2>
          <p>{c.summary}</p>
          {c.latency.p50 !== undefined ? (
            <p className="mt-1 text-xs text-slate-500">
              {t("latency", { p50: c.latency.p50, max: c.latency.max ?? 0 })}
            </p>
          ) : null}
          {c.usage.stt_ms ? (
            <p className="text-xs text-slate-500">
              {t("usage", { stt: Math.round((c.usage.stt_ms ?? 0) / 1000), tts: c.usage.tts_chars ?? 0 })}
            </p>
          ) : null}
        </section>
      ) : null}

      {data.tasks.length ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <h2 className="font-semibold">{t("tasks")}</h2>
          <ul>
            {data.tasks.map((task) => (
              <li key={task.id} className={task.priority === "critical" ? "font-semibold text-red-700" : ""}>
                {task.title} {task.status !== "open" ? "✓" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-500">{t("recording")}</h2>
        {data.recordingUrl ? (
          <audio controls preload="none" src={data.recordingUrl} className="w-full" />
        ) : (
          <p className="text-sm text-slate-500">{t("noRecording")}</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">{t("transcript")}</h2>
        {data.turns.map((turn) => (
          <div
            key={turn.seq}
            className={`flex ${turn.speaker === "caller" ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                turn.speaker === "caller"
                  ? "bg-white"
                  : turn.speaker === "system"
                    ? "bg-slate-100 text-slate-500 italic"
                    : turn.flags.includes("emergency")
                      ? "bg-red-50"
                      : "bg-emerald-50"
              }`}
            >
              <p className="mb-0.5 text-[10px] font-medium text-slate-500 uppercase">{t(turn.speaker)}</p>
              <p className="whitespace-pre-line">{turn.text}</p>
              {turn.latency_ms ? (
                <p className="mt-1 text-right text-[10px] text-slate-400">{turn.latency_ms} ms</p>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      {can("appointments.write") ? (
        <section className="space-y-2 rounded-2xl border border-violet-200 bg-violet-50 p-4">
          <h2 className="font-semibold">{t("testCall")}</h2>
          <div className="flex gap-2">
            {(["pass", "fail"] as const).map((r) => (
              <button
                key={r}
                aria-pressed={result === r}
                onClick={() => setResult(r)}
                className="min-h-11 flex-1 rounded-xl border border-slate-300 bg-white aria-pressed:border-violet-600 aria-pressed:bg-violet-600 aria-pressed:text-white"
              >
                {t(r)}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("notes")}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-base"
          />
          <Button
            disabled={!result}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/v1/calls/${id}/test`, {
                  method: "POST",
                  body: { result, notes: notes || undefined },
                });
                toast(t("saveResult"));
                await load();
              } catch (e) {
                toast(e instanceof ApiError ? e.message : "Error", "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("saveResult")}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

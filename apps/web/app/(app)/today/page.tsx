"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppointmentSheet, nextSteps } from "../../../components/appointment-sheet";
import { BookingSheet, type BookingDraft } from "../../../components/booking-sheet";
import { ConfirmWarnings } from "../../../components/confirm-warnings";
import { Button, EmptyState, Spinner, StatusBadge } from "../../../components/ui";
import { useAppointmentActions } from "../../../lib/appointment-actions";
import { useAppointments, useClinicConfig } from "../../../lib/data";
import { useSession } from "../../../lib/session";
import { dayRange, formatClock, formatDay, localMinutesOf, todayIn } from "../../../lib/time";
import type { Appointment } from "../../../lib/types";

const GROUPS = [
  { key: "inClinic", statuses: ["checked_in", "in_chair"] },
  { key: "upcoming", statuses: ["booked", "confirmed"] },
  { key: "finished", statuses: ["completed"] },
  { key: "missed", statuses: ["no_show", "cancelled"] },
] as const;

export default function TodayPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { api, can } = useSession();
  const config = useClinicConfig();
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz);
  const range = useMemo(() => dayRange(today, tz), [today, tz]);
  const appts = useAppointments(range);
  const actions = useAppointmentActions(appts.setData, appts.reload);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [openTasks, setOpenTasks] = useState<{ priority: string }[]>([]);
  const [setup, setSetup] = useState<{
    ready: boolean;
    done: number;
    total: number;
    testMode: { on: boolean };
  } | null>(null);
  const owner = can("settings.manage");
  useEffect(() => {
    if (!owner) return;
    api<{ ready: boolean; done: number; total: number; testMode: { on: boolean } }>("/v1/setup")
      .then(setSetup)
      .catch(() => {});
  }, [api, owner]);
  const seesTasks = can("appointments.read");
  useEffect(() => {
    if (!seesTasks) return;
    api<{ priority: string }[]>("/v1/tasks")
      .then(setOpenTasks)
      .catch(() => {});
  }, [api, seesTasks]);

  const list = appts.data ?? [];
  const counts = {
    total: list.filter((a) => a.status !== "cancelled").length,
    waiting: list.filter((a) => a.status === "checked_in").length,
    done: list.filter((a) => a.status === "completed").length,
  };
  const editable = can("appointments.write");

  function newWalkIn() {
    const now = localMinutesOf(new Date(), tz);
    const step = config.data?.clinic.slot_step_min ?? 15;
    setDraft({ date: today, startMin: Math.ceil(now / step) * step });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t("today.title")}</h1>
          <p className="text-sm text-slate-600">{formatDay(today, locale)}</p>
        </div>
        {editable && config.data ? (
          <Button onClick={newWalkIn} className="shrink-0 whitespace-nowrap">
            + {t("today.new")}
          </Button>
        ) : null}
      </div>

      {setup && (!setup.ready || setup.testMode.on) ? (
        <Link
          href="/setup"
          data-testid="setup-banner"
          className="block rounded-xl bg-sky-50 px-3 py-2 text-sm font-medium text-sky-900 ring-1 ring-sky-200"
        >
          {setup.ready
            ? t("today.setupTestMode")
            : t("today.setup", { done: setup.done, total: setup.total })}{" "}
          ›
        </Link>
      ) : null}

      {openTasks.length ? (
        <Link
          href="/tasks"
          className={`block rounded-xl px-3 py-2 text-sm font-medium ${openTasks.some((x) => x.priority === "critical") ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}
        >
          {t("today.tasksWaiting", { count: openTasks.length })} ›
        </Link>
      ) : null}

      {appts.cachedAt ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("common.offlineCopy", { time: formatClock(new Date(appts.cachedAt), tz, locale) })}
        </p>
      ) : null}

      {appts.loading && !appts.data ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState>{t("today.empty")}</EmptyState>
      ) : (
        <>
          <p className="text-sm text-slate-700" data-testid="today-summary">
            {t("today.summary", counts)}
          </p>
          {GROUPS.map((group) => {
            const items = list.filter((a) => (group.statuses as readonly string[]).includes(a.status));
            if (items.length === 0) return null;
            return (
              <section key={group.key} className="space-y-2">
                <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  {t(`today.${group.key}`)}
                </h2>
                <ul className="space-y-2">
                  {items.map((a) => (
                    <li
                      key={a.id}
                      className={`rounded-2xl border border-slate-200 bg-white p-3 ${a.pending ? "opacity-70" : ""}`}
                    >
                      <button
                        className="flex w-full items-start justify-between gap-3 text-left"
                        onClick={() => setSelected(a)}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold tabular-nums">
                            {formatClock(a.startsAt, tz, locale)}
                          </p>
                          <p className="truncate font-medium">{a.patient.name}</p>
                          <p className="truncate text-xs text-slate-500">
                            {a.procedure
                              ? locale === "hi" && a.procedure.nameHi
                                ? a.procedure.nameHi
                                : a.procedure.name
                              : t("appointment.noProcedure")}{" "}
                            · {a.doctor.name}
                          </p>
                        </div>
                        <StatusBadge status={a.status} label={t(`status.${a.status}`)} />
                      </button>
                      {editable && nextSteps(a.status).length > 0 && a.status !== "no_show" ? (
                        <div className="mt-2 flex gap-2">
                          {nextSteps(a.status)
                            .filter((s) => s.status !== "confirmed")
                            .map((s) => (
                              <Button
                                key={s.status}
                                variant={s.status === "no_show" ? "secondary" : "primary"}
                                className="min-h-9 flex-1 py-1"
                                onClick={() => void actions.setStatus(a, s.status)}
                              >
                                {t(`actions.${s.key}`)}
                              </Button>
                            ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}

      {config.data ? (
        <>
          <AppointmentSheet
            appointment={selected}
            config={config.data}
            canEdit={editable}
            onClose={() => setSelected(null)}
            onStatus={actions.setStatus}
            onCancel={actions.cancel}
            onMove={(a, c) => actions.move(a, c)}
          />
          <BookingSheet
            open={!!draft}
            onClose={() => setDraft(null)}
            config={config.data}
            draft={draft}
            onBook={actions.book}
          />
        </>
      ) : null}
      <ConfirmWarnings confirmation={actions.confirmation} onClose={actions.clearConfirmation} />
    </div>
  );
}

"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppointmentSheet } from "../../../components/appointment-sheet";
import { BookingSheet, type BookingDraft } from "../../../components/booking-sheet";
import { CheckoutSheet } from "../../../components/checkout-sheet";
import { ConfirmWarnings } from "../../../components/confirm-warnings";
import { Button, Field, Select, Sheet, Spinner, StatusBadge, useToast } from "../../../components/ui";
import { WalkInSheet } from "../../../components/walk-in-sheet";
import { ApiError } from "../../../lib/api";
import { useAppointmentActions } from "../../../lib/appointment-actions";
import { useAppointments, useClinicConfig } from "../../../lib/data";
import { useSession } from "../../../lib/session";
import { dayRange, formatClock, formatDay, formatRupees, localMinutesOf, todayIn } from "../../../lib/time";
import type { Appointment, Patient } from "../../../lib/types";

interface QueueEntry {
  id: string;
  token: number;
  status: "waiting" | "with_doctor" | "done" | "left";
  arrivedAt: string;
  calledAt: string | null;
  note: string | null;
  appointmentId: string | null;
  walkIn: boolean;
  bookedFor: string | null;
  patient: { id: string; name: string; phone: string | null };
  doctor: { id: string; name: string } | null;
  procedure: { id: string; name: string; nameHi: string | null } | null;
}
interface Desk {
  date: string;
  queue: QueueEntry[];
  assistant: { calls: number; booked: number; chats: number; reminders: number; emergencies: number };
  billing: Record<string, { chargedPaise: number; paidPaise: number }> | null;
}

export default function TodayPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12 text-slate-400">
          <Spinner />
        </div>
      }
    >
      <Today />
    </Suspense>
  );
}

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));

/**
 * The front desk's day on one screen. Desk computers see four columns side by side (waiting with tokens,
 * with the doctor, coming up, finished with what's been paid); phones see the same as one list.
 */
function Today() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { api, can } = useSession();
  const config = useClinicConfig();
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";
  const today = todayIn(tz);
  const range = useMemo(() => dayRange(today, tz), [today, tz]);
  const appts = useAppointments(range);
  const [desk, setDesk] = useState<Desk | null>(null);
  const reloadDesk = useCallback(
    () =>
      api<Desk>("/v1/desk")
        .then(setDesk)
        .catch(() => {}),
    [api],
  );
  const reloadAll = useCallback(async () => {
    await Promise.all([appts.reload(), reloadDesk()]);
  }, [appts, reloadDesk]);
  const actions = useAppointmentActions(appts.setData, reloadAll);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [sending, setSending] = useState<QueueEntry | null>(null);
  const [checkout, setCheckout] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<{ priority: string }[]>([]);
  const [setup, setSetup] = useState<{
    ready: boolean;
    done: number;
    total: number;
    testMode: { on: boolean };
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const editable = can("appointments.write");
  const billing = can("billing.read");
  const owner = can("settings.manage");

  useEffect(() => {
    void reloadDesk();
    const timer = setInterval(() => {
      setNow(Date.now());
      void reloadDesk();
    }, 20_000);
    return () => clearInterval(timer);
  }, [reloadDesk]);
  useEffect(() => {
    if (!can("appointments.read")) return;
    api<{ priority: string }[]>("/v1/tasks")
      .then(setOpenTasks)
      .catch(() => {});
  }, [api, can]);
  useEffect(() => {
    if (!owner) return;
    api<{ ready: boolean; done: number; total: number; testMode: { on: boolean } }>("/v1/setup")
      .then(setSetup)
      .catch(() => {});
  }, [api, owner]);

  const newAppointment = useCallback(
    (patient?: Patient | { id: string; name: string; phone: string | null } | null) => {
      const current = localMinutesOf(new Date(), tz);
      const step = config.data?.clinic.slot_step_min ?? 15;
      setDraft({
        date: today,
        startMin: Math.ceil(current / step) * step,
        patient: (patient as Patient) ?? null,
      });
    },
    [config.data, today, tz],
  );

  // Quick actions from the top bar (+ Walk-in, + Appointment) land here.
  useEffect(() => {
    if (!config.data) return;
    if (params.get("walkin")) setWalkIn(true);
    else if (params.get("book")) newAppointment();
    else return;
    router.replace("/today");
  }, [params, config.data, newAppointment, router]);

  const list = appts.data ?? [];
  const queue = desk?.queue ?? [];
  const tokenOf = (appointmentId: string) => queue.find((q) => q.appointmentId === appointmentId)?.token;
  const waiting = queue.filter((q) => q.status === "waiting");
  const withDoctor = list
    .filter((a) => a.status === "in_chair")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const upcoming = list
    .filter((a) => a.status === "booked" || a.status === "confirmed")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const finished = list
    .filter((a) => a.status === "completed")
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const missed = list.filter((a) => a.status === "no_show" || a.status === "cancelled");
  const procName = (p: { name: string; nameHi: string | null } | null) =>
    p ? (locale === "hi" && p.nameHi ? p.nameHi : p.name) : t("appointment.noProcedure");

  const sendIn = async (entry: QueueEntry, body: { doctorId?: string; chairId?: string } = {}) => {
    try {
      await api(`/v1/queue/${entry.id}/send-in`, { method: "POST", body });
      setSending(null);
      await reloadAll();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("common.error"), "error");
    }
  };
  const left = async (entry: QueueEntry) => {
    try {
      await api(`/v1/queue/${entry.id}/left`, { method: "POST" });
      await reloadDesk();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("common.error"), "error");
    }
  };
  const finish = async (a: Appointment) => {
    await actions.setStatus(a, "completed");
    await reloadDesk();
    if (billing) setCheckout(a.id);
  };

  const a = desk?.assistant;
  const assistantBits = a
    ? [
        a.calls ? t("desk.aCalls", { n: a.calls }) : null,
        a.booked ? t("desk.aBooked", { n: a.booked }) : null,
        a.chats ? t("desk.aChats", { n: a.chats }) : null,
        a.reminders ? t("desk.aReminders", { n: a.reminders }) : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 lg:max-w-none lg:px-6">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t("today.title")}</h1>
          <p className="text-sm text-slate-600">{formatDay(today, locale)}</p>
        </div>
      </div>
      {editable && config.data ? (
        <div className="grid grid-cols-2 gap-2 md:hidden">
          <Button variant="secondary" onClick={() => setWalkIn(true)}>
            + {t("nav.walkIn")}
          </Button>
          <Button onClick={() => newAppointment()}>+ {t("nav.appointment")}</Button>
        </div>
      ) : null}

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

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {openTasks.length ? (
          <Link
            href="/tasks"
            className={`block rounded-xl px-3 py-2 text-sm font-medium ${openTasks.some((x) => x.priority === "critical") ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}
          >
            {t("today.tasksWaiting", { count: openTasks.length })} ›
          </Link>
        ) : null}
        {a ? (
          <div
            className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-700 ring-1 ring-brand-600/20"
            data-testid="assistant-today"
          >
            <span className="font-medium">{t("desk.assistantToday")}</span>{" "}
            {assistantBits.length ? assistantBits.join(" · ") : t("desk.assistantQuiet")}
            {a.emergencies ? (
              <span className="ml-1 font-semibold text-red-700">
                · {t("desk.aEmergencies", { n: a.emergencies })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {appts.cachedAt ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("common.offlineCopy", { time: formatClock(new Date(appts.cachedAt), tz, locale) })}
        </p>
      ) : null}

      {appts.loading && !appts.data ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-700" data-testid="today-summary">
            {t("desk.summary", {
              total: list.filter((x) => x.status !== "cancelled").length,
              waiting: waiting.length,
              done: finished.length,
            })}
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Column
              title={t("desk.waiting")}
              count={waiting.length}
              testId="col-waiting"
              empty={t("desk.noneWaiting")}
            >
              {waiting.map((q) => {
                const mins = minutesSince(q.arrivedAt, now);
                const appt = q.appointmentId ? list.find((x) => x.id === q.appointmentId) : undefined;
                return (
                  <CardShell key={q.id}>
                    <div className="flex items-start gap-3">
                      <Token n={q.token} />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/patients/${q.patient.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {q.patient.name}
                        </Link>
                        <p className="truncate text-xs text-slate-500">
                          {q.walkIn
                            ? t("desk.walkIn")
                            : t("desk.bookedFor", { time: formatClock(q.bookedFor!, tz, locale) })}
                          {" · "}
                          {procName(q.procedure)}
                          {" · "}
                          {q.doctor?.name ?? t("desk.anyDoctor")}
                        </p>
                        {q.note ? <p className="mt-0.5 text-xs text-slate-700">“{q.note}”</p> : null}
                      </div>
                      <span
                        className={`shrink-0 text-xs font-medium tabular-nums ${mins >= 40 ? "text-red-700" : mins >= 20 ? "text-amber-700" : "text-slate-500"}`}
                      >
                        {t("desk.waitingFor", { n: mins })}
                      </span>
                    </div>
                    {editable ? (
                      <div className="mt-2 flex gap-2">
                        <Button
                          className="min-h-9 flex-1 py-1"
                          onClick={() =>
                            q.walkIn
                              ? setSending(q)
                              : appt
                                ? void actions.setStatus(appt, "in_chair").then(reloadDesk)
                                : void sendIn(q)
                          }
                        >
                          {t("desk.sendIn")}
                        </Button>
                        {q.walkIn ? (
                          <Button variant="secondary" className="min-h-9 py-1" onClick={() => void left(q)}>
                            {t("desk.left")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </CardShell>
                );
              })}
            </Column>

            <Column
              title={t("desk.withDoctor")}
              count={withDoctor.length}
              testId="col-with-doctor"
              empty={t("desk.noneWithDoctor")}
            >
              {withDoctor.map((x) => (
                <CardShell key={x.id} pending={x.pending}>
                  <button className="flex w-full items-start gap-3 text-left" onClick={() => setSelected(x)}>
                    {tokenOf(x.id) ? <Token n={tokenOf(x.id)!} /> : null}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{x.patient.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {procName(x.procedure)} · {x.doctor.name} · {x.chair.name}
                      </p>
                    </div>
                  </button>
                  {editable ? (
                    <Button className="mt-2 min-h-9 w-full py-1" onClick={() => void finish(x)}>
                      {billing ? t("desk.doneCheckout") : t("actions.complete")}
                    </Button>
                  ) : null}
                </CardShell>
              ))}
            </Column>

            <Column
              title={t("desk.comingUp")}
              count={upcoming.length}
              testId="col-coming-up"
              empty={t("desk.noneComing")}
            >
              {upcoming.map((x) => {
                const late = minutesSince(x.startsAt, now);
                const isLate = new Date(x.startsAt).getTime() < now && late >= 5;
                return (
                  <CardShell key={x.id} pending={x.pending}>
                    <button
                      className="flex w-full items-start justify-between gap-3 text-left"
                      onClick={() => setSelected(x)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold tabular-nums">
                          {formatClock(x.startsAt, tz, locale)}
                          {isLate ? (
                            <span className="ml-2 text-xs font-medium text-amber-700">
                              {t("desk.late", { n: late })}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate font-medium">{x.patient.name}</p>
                        <p className="truncate text-xs text-slate-500">
                          {procName(x.procedure)} · {x.doctor.name}
                        </p>
                      </div>
                      <StatusBadge status={x.status} label={t(`status.${x.status}`)} />
                    </button>
                    {editable ? (
                      <div className="mt-2 flex gap-2">
                        <Button
                          className="min-h-9 flex-1 py-1"
                          onClick={() => void actions.setStatus(x, "checked_in").then(reloadDesk)}
                        >
                          {t("actions.checkIn")}
                        </Button>
                        <Button
                          variant="secondary"
                          className="min-h-9 flex-1 py-1"
                          onClick={() => void actions.setStatus(x, "no_show").then(reloadDesk)}
                        >
                          {t("actions.noShow")}
                        </Button>
                      </div>
                    ) : null}
                  </CardShell>
                );
              })}
            </Column>

            <Column
              title={t("desk.finished")}
              count={finished.length}
              testId="col-finished"
              empty={t("desk.noneFinished")}
            >
              {finished.map((x) => {
                const b = desk?.billing?.[x.id];
                const due = b ? b.chargedPaise - b.paidPaise : 0;
                return (
                  <CardShell key={x.id} pending={x.pending}>
                    <div className="flex items-start justify-between gap-3">
                      <button className="min-w-0 text-left" onClick={() => setSelected(x)}>
                        <p className="truncate font-medium">{x.patient.name}</p>
                        <p className="truncate text-xs text-slate-500">
                          {procName(x.procedure)} · {x.doctor.name}
                        </p>
                      </button>
                      {desk?.billing ? (
                        !b || b.chargedPaise === 0 ? (
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {t("desk.notBilled")}
                          </span>
                        ) : due > 0 ? (
                          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                            {t("desk.due", { amount: formatRupees(due, locale) })}
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                            {t("desk.paid", { amount: formatRupees(b.paidPaise, locale) })}
                          </span>
                        )
                      ) : null}
                    </div>
                    {billing && (!b || due > 0 || b.chargedPaise === 0) ? (
                      <Button
                        variant="secondary"
                        className="mt-2 min-h-9 w-full py-1"
                        onClick={() => setCheckout(x.id)}
                      >
                        {t("desk.checkout")}
                      </Button>
                    ) : null}
                  </CardShell>
                );
              })}
              {missed.length ? (
                <details className="rounded-2xl border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-600">
                  <summary className="cursor-pointer">{t("desk.missed", { n: missed.length })}</summary>
                  <ul className="mt-2 space-y-1">
                    {missed.map((x) => (
                      <li key={x.id}>
                        <button
                          className="flex w-full justify-between gap-2 text-left"
                          onClick={() => setSelected(x)}
                        >
                          <span className="truncate">
                            {formatClock(x.startsAt, tz, locale)} {x.patient.name}
                          </span>
                          <StatusBadge status={x.status} label={t(`status.${x.status}`)} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Column>
          </div>
        </>
      )}

      {config.data ? (
        <>
          <AppointmentSheet
            appointment={selected}
            config={config.data}
            canEdit={editable}
            onClose={() => setSelected(null)}
            onStatus={async (x, s) => {
              if (s === "completed") {
                setSelected(null);
                await finish(x);
              } else {
                await actions.setStatus(x, s);
                await reloadDesk();
              }
            }}
            onCancel={actions.cancel}
            onMove={(x, c) => actions.move(x, c)}
            onCheckout={
              billing
                ? (x) => {
                    setSelected(null);
                    setCheckout(x.id);
                  }
                : undefined
            }
          />
          <BookingSheet
            open={!!draft}
            onClose={() => setDraft(null)}
            config={config.data}
            draft={draft}
            onBook={actions.book}
          />
          <WalkInSheet
            open={walkIn}
            onClose={() => setWalkIn(false)}
            config={config.data}
            onAdded={() => void reloadDesk()}
          />
          <SendInSheet
            entry={sending}
            doctors={config.data.doctors.filter((d) => d.active)}
            chairs={config.data.chairs.filter((c) => c.active)}
            busyChairs={withDoctor.map((x) => x.chair.id)}
            busyDoctors={withDoctor.map((x) => x.doctor.id)}
            onClose={() => setSending(null)}
            onSend={(body) => void sendIn(sending!, body)}
          />
          <CheckoutSheet
            appointmentId={checkout}
            onClose={() => setCheckout(null)}
            onChanged={() => void reloadDesk()}
            onBookNext={(p) => {
              setCheckout(null);
              newAppointment(p);
            }}
          />
        </>
      ) : null}
      <ConfirmWarnings confirmation={actions.confirmation} onClose={actions.clearConfirmation} />
    </div>
  );
}

function Column({
  title,
  count,
  children,
  testId,
  empty,
}: {
  title: string;
  count: number;
  children: ReactNode;
  testId: string;
  empty: string;
}) {
  return (
    <section className="min-w-0 space-y-2" data-testid={testId}>
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {title}
        <span className="rounded-full bg-slate-100 px-1.5 text-slate-600">{count}</span>
      </h2>
      <div className="space-y-2">
        {children}
        {count === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-400">
            {empty}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CardShell({ children, pending }: { children: ReactNode; pending?: boolean }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-3 ${pending ? "opacity-70" : ""}`}>
      {children}
    </div>
  );
}

function Token({ n }: { n: number }) {
  const t = useTranslations("desk");
  return (
    <span
      aria-label={t("token", { n })}
      className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white tabular-nums"
    >
      {n}
    </span>
  );
}

/** Sending a walk-in to the doctor: pick who sees them and where (free doctors and chairs first). */
function SendInSheet({
  entry,
  doctors,
  chairs,
  busyChairs,
  busyDoctors,
  onClose,
  onSend,
}: {
  entry: QueueEntry | null;
  doctors: { id: string; name: string }[];
  chairs: { id: string; name: string }[];
  busyChairs: string[];
  busyDoctors: string[];
  onClose: () => void;
  onSend: (body: { doctorId: string; chairId: string }) => void;
}) {
  const t = useTranslations("desk");
  const [doctorId, setDoctorId] = useState("");
  const [chairId, setChairId] = useState("");
  useEffect(() => {
    if (!entry) return;
    setDoctorId(
      entry.doctor?.id ?? doctors.find((d) => !busyDoctors.includes(d.id))?.id ?? doctors[0]?.id ?? "",
    );
    setChairId(chairs.find((c) => !busyChairs.includes(c.id))?.id ?? chairs[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
  return (
    <Sheet open={!!entry} onClose={onClose} title={t("sendInTitle", { name: entry?.patient.name ?? "" })}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("doctor")}>
            {(id) => (
              <Select id={id} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {busyDoctors.includes(d.id) ? ` (${t("busy")})` : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("chair")}>
            {(id) => (
              <Select id={id} value={chairId} onChange={(e) => setChairId(e.target.value)}>
                {chairs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {busyChairs.includes(c.id) ? ` (${t("busy")})` : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <p className="text-xs text-slate-500">{t("sendInHelp")}</p>
        <Button
          className="w-full"
          disabled={!doctorId || !chairId}
          onClick={() => onSend({ doctorId, chairId })}
        >
          {t("sendIn")}
        </Button>
      </div>
    </Sheet>
  );
}

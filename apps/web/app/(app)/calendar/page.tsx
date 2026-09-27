"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { AppointmentSheet } from "../../../components/appointment-sheet";
import { BookingSheet, type BookingDraft } from "../../../components/booking-sheet";
import { ConfirmWarnings } from "../../../components/confirm-warnings";
import { DayGrid, type GridColumn } from "../../../components/day-grid";
import { Button, Spinner } from "../../../components/ui";
import { useAppointmentActions } from "../../../lib/appointment-actions";
import { useAppointments, useClinicConfig } from "../../../lib/data";
import { doctorWindows, isHoliday, toScheduleConfig } from "../../../lib/schedule";
import { useSession } from "../../../lib/session";
import {
  addDays,
  dayRange,
  formatClock,
  formatDay,
  localMinutesOf,
  todayIn,
  weekdayOf,
  zonedInstant,
} from "../../../lib/time";
import type { Appointment } from "../../../lib/types";

export default function CalendarPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { can } = useSession();
  const config = useClinicConfig();
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";
  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setView] = useState<"doctor" | "chair">("doctor");
  const range = useMemo(() => dayRange(date, tz), [date, tz]);
  const appts = useAppointments(range);
  const actions = useAppointmentActions(appts.setData, appts.reload);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const editable = can("appointments.write");

  const layout = useMemo(() => {
    if (!config.data) return null;
    const schedule = toScheduleConfig(config.data);
    const branchId = config.data.branches[0]?.id ?? "";
    const list = appts.data ?? [];
    const holiday = config.data.holidays.find(
      (h) => h.date === date && (h.branch_id === null || h.branch_id === branchId),
    );
    let columns: GridColumn[];
    if (view === "doctor") {
      columns = config.data.doctors
        .filter((d) => d.active)
        .map((d) => {
          const open = doctorWindows(
            schedule,
            { id: d.id, name: d.name, kind: d.kind, active: d.active },
            branchId,
            date,
          ) as [number, number][];
          return {
            id: d.id,
            title: d.name,
            subtitle:
              d.kind === "visiting" && open.length ? t("calendar.visiting") : (d.speciality ?? undefined),
            color: d.color,
            open,
          };
        })
        .filter(
          (c) =>
            c.open.length > 0 ||
            list.some((a) => a.doctor.id === c.id) ||
            config.data!.doctors.find((d) => d.id === c.id)?.kind === "permanent",
        );
    } else {
      const clinicHours = isHoliday(schedule, branchId, date)
        ? []
        : (config.data.workingHours
            .filter((w) => w.doctor_id === null && w.weekday === weekdayOf(date))
            .map((w) => [toMin(w.start), toMin(w.end)]) as [number, number][]);
      columns = config.data.chairs
        .filter((c) => c.active)
        .map((c) => ({ id: c.id, title: c.name, open: clinicHours }));
    }
    const allOpen = columns.flatMap((c) => c.open);
    const apptMins = list.flatMap((a) => [
      localMinutesOf(new Date(a.startsAt), tz),
      localMinutesOf(new Date(a.endsAt), tz),
    ]);
    const earliest = Math.min(9 * 60, ...allOpen.map((o) => o[0]), ...apptMins);
    const latest = Math.max(20 * 60, ...allOpen.map((o) => o[1]), ...apptMins);
    return {
      columns,
      holiday,
      start: Math.max(0, Math.floor((earliest - 30) / 60) * 60),
      end: Math.min(24 * 60, Math.ceil((latest + 30) / 60) * 60),
    };
  }, [config.data, appts.data, date, view, tz, t]);

  const columnOf = (a: Appointment) => (view === "doctor" ? a.doctor.id : a.chair.id);

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label={t("calendar.prevDay")}
            onClick={() => setDate(addDays(date, -1))}
          >
            ‹
          </Button>
          <div className="text-center">
            <p className="font-semibold">{formatDay(date, locale)}</p>
            {date !== todayIn(tz) ? (
              <button className="text-xs text-brand-700 underline" onClick={() => setDate(todayIn(tz))}>
                {t("common.today")}
              </button>
            ) : null}
          </div>
          <Button
            variant="ghost"
            aria-label={t("calendar.nextDay")}
            onClick={() => setDate(addDays(date, 1))}
          >
            ›
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-h-11 rounded-xl border border-slate-300 px-2 text-sm"
          />
          <div className="flex rounded-xl border border-slate-300 p-0.5 text-sm">
            {(["doctor", "chair"] as const).map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                className="rounded-lg px-3 py-1.5 aria-pressed:bg-brand-600 aria-pressed:text-white"
                onClick={() => setView(v)}
              >
                {t(v === "doctor" ? "calendar.byDoctor" : "calendar.byChair")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {appts.cachedAt ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("common.offlineCopy", { time: formatClock(new Date(appts.cachedAt), tz, locale) })}
        </p>
      ) : null}
      {layout?.holiday ? (
        <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {t("calendar.holiday", { name: layout.holiday.name })}
        </p>
      ) : null}
      {editable ? <p className="text-xs text-slate-500">{t("calendar.hint")}</p> : null}

      {!config.data || !layout ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Spinner />
        </div>
      ) : (
        <DayGrid
          columns={layout.columns}
          appointments={appts.data ?? []}
          columnOf={columnOf}
          timezone={tz}
          dayStartMin={layout.start}
          dayEndMin={layout.end}
          slotStepMin={config.data.clinic.slot_step_min}
          editable={editable}
          onTapAppointment={setSelected}
          onTapEmpty={(columnId, minutes) =>
            setDraft({
              date,
              startMin: minutes,
              ...(view === "doctor" ? { doctorId: columnId } : { chairId: columnId }),
            })
          }
          onDrop={(a, change) => {
            const start = zonedInstant(date, change.startMin, tz);
            const end = zonedInstant(date, change.endMin, tz);
            void actions.move(a, {
              startsAt: start.toISOString(),
              endsAt: end.toISOString(),
              ...(change.columnId !== columnOf(a)
                ? view === "doctor"
                  ? { doctorId: change.columnId }
                  : { chairId: change.columnId }
                : {}),
            });
          }}
        />
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

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

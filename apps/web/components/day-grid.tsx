"use client";

import { useLocale } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { localMinutesOf, minutesToClock } from "../lib/time";
import type { Appointment } from "../lib/types";

export interface GridColumn {
  id: string;
  title: string;
  subtitle?: string;
  color?: string | null;
  /** Working periods as [startMin, endMin); the rest is shaded. */
  open: [number, number][];
}

interface DragState {
  id: string;
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  deltaMin: number;
  columnId: string;
}

const PX_PER_MIN = 1.6;
const LONG_PRESS_MS = 350;
const SNAP_MIN = 5;

/**
 * Day calendar: one column per doctor (or chair). Press and hold an appointment to drag it to another
 * time or column; drag the bottom edge to change its length. Tap an empty spot to book there.
 */
export function DayGrid({
  columns,
  appointments,
  columnOf,
  timezone,
  dayStartMin,
  dayEndMin,
  slotStepMin,
  editable,
  onTapEmpty,
  onTapAppointment,
  onDrop,
}: {
  columns: GridColumn[];
  appointments: Appointment[];
  columnOf: (a: Appointment) => string;
  timezone: string;
  dayStartMin: number;
  dayEndMin: number;
  slotStepMin: number;
  editable: boolean;
  onTapEmpty: (columnId: string, minutes: number) => void;
  onTapAppointment: (a: Appointment) => void;
  onDrop: (a: Appointment, change: { startMin: number; endMin: number; columnId: string }) => void;
}) {
  const locale = useLocale();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const height = (dayEndMin - dayStartMin) * PX_PER_MIN;

  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // While dragging on a touch screen, stop the page from scrolling (needs a non-passive listener).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (dragRef.current?.active) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  function columnAt(clientX: number): string | null {
    for (const [id, el] of columnRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) return id;
    }
    return null;
  }

  function begin(e: React.PointerEvent, a: Appointment, mode: DragState["mode"]) {
    if (!editable || !["booked", "confirmed", "checked_in"].includes(a.status)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state: DragState = {
      id: a.id,
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: mode === "resize" || e.pointerType === "mouse",
      deltaMin: 0,
      columnId: columnOf(a),
    };
    update(state);
    if (!state.active) {
      timer.current = setTimeout(() => {
        if (dragRef.current?.id === a.id) {
          update({ ...dragRef.current, active: true });
          navigator.vibrate?.(20);
        }
      }, LONG_PRESS_MS);
    }
  }

  function moveDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    const dx = e.clientX - d.startX;
    if (!d.active) {
      // Moved before the long press finished: it was a scroll, not a drag.
      if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        if (timer.current) clearTimeout(timer.current);
        update(null);
      }
      return;
    }
    const deltaMin = Math.round(dy / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
    const columnId = d.mode === "move" ? (columnAt(e.clientX) ?? d.columnId) : d.columnId;
    if (deltaMin !== d.deltaMin || columnId !== d.columnId) update({ ...d, deltaMin, columnId });
  }

  function endDrag(e: React.PointerEvent, a: Appointment) {
    if (timer.current) clearTimeout(timer.current);
    const d = dragRef.current;
    update(null);
    if (!d || e.pointerId !== d.pointerId) return;
    const start = localMinutesOf(new Date(a.startsAt), timezone);
    const end = localMinutesOf(new Date(a.endsAt), timezone);
    if (!d.active || (d.deltaMin === 0 && d.columnId === columnOf(a))) {
      if (!d.active || d.mode === "move") onTapAppointment(a);
      return;
    }
    if (d.mode === "move")
      onDrop(a, { startMin: start + d.deltaMin, endMin: end + d.deltaMin, columnId: d.columnId });
    else
      onDrop(a, {
        startMin: start,
        endMin: Math.max(start + SNAP_MIN, end + d.deltaMin),
        columnId: d.columnId,
      });
  }

  const hours: number[] = [];
  for (let m = Math.ceil(dayStartMin / 60) * 60; m < dayEndMin; m += 60) hours.push(m);

  return (
    <div
      ref={scroller}
      className="overflow-x-auto rounded-2xl border border-slate-200 bg-white"
      data-testid="day-grid"
    >
      <div className="flex min-w-max">
        <div className="sticky left-0 z-10 w-12 shrink-0 border-r border-slate-100 bg-white">
          <div className="h-12 border-b border-slate-100" />
          <div className="relative" style={{ height }}>
            {hours.map((m) => (
              <span
                key={m}
                className="absolute right-1 -translate-y-2 text-[10px] text-slate-400 tabular-nums"
                style={{ top: (m - dayStartMin) * PX_PER_MIN }}
              >
                {minutesToClock(m)}
              </span>
            ))}
          </div>
        </div>
        {columns.map((col) => (
          <div key={col.id} className="w-40 shrink-0 border-r border-slate-100 sm:w-48">
            <div className="flex h-12 flex-col justify-center border-b border-slate-100 px-2">
              <p className="truncate text-sm font-medium" style={{ color: col.color ?? undefined }}>
                {col.title}
              </p>
              {col.subtitle ? <p className="truncate text-[11px] text-slate-500">{col.subtitle}</p> : null}
            </div>
            <div
              ref={(el) => {
                if (el) columnRefs.current.set(col.id, el);
                else columnRefs.current.delete(col.id);
              }}
              className="relative bg-slate-100"
              style={{ height }}
              data-column={col.id}
              data-day-start={dayStartMin}
              onClick={(e) => {
                if (!editable) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const minutes = dayStartMin + (e.clientY - rect.top) / PX_PER_MIN;
                onTapEmpty(col.id, Math.floor(minutes / slotStepMin) * slotStepMin);
              }}
            >
              {col.open.map(([s, en]) => (
                <div
                  key={s}
                  className="absolute inset-x-0 bg-white"
                  style={{ top: (s - dayStartMin) * PX_PER_MIN, height: (en - s) * PX_PER_MIN }}
                />
              ))}
              {hours.map((m) => (
                <div
                  key={m}
                  className="pointer-events-none absolute inset-x-0 border-t border-slate-100"
                  style={{ top: (m - dayStartMin) * PX_PER_MIN }}
                />
              ))}
              {appointments
                .filter(
                  (a) =>
                    (drag?.id === a.id ? drag.columnId : columnOf(a)) === col.id && a.status !== "cancelled",
                )
                .map((a) => {
                  const start = localMinutesOf(new Date(a.startsAt), timezone);
                  const end = localMinutesOf(new Date(a.endsAt), timezone);
                  const dragging = drag?.id === a.id && drag.active;
                  const shownStart = dragging && drag.mode === "move" ? start + drag.deltaMin : start;
                  const shownEnd = dragging
                    ? drag.mode === "move"
                      ? end + drag.deltaMin
                      : Math.max(start + SNAP_MIN, end + drag.deltaMin)
                    : end;
                  const finished = a.status === "completed" || a.status === "no_show";
                  return (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      data-testid={`appt-${a.patient.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => begin(e, a, "move")}
                      onPointerMove={moveDrag}
                      onPointerUp={(e) => endDrag(e, a)}
                      onPointerCancel={() => update(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onTapAppointment(a);
                      }}
                      className={`absolute inset-x-1 overflow-hidden rounded-lg border-l-4 px-1.5 py-0.5 text-xs select-none ${
                        finished
                          ? "border-slate-300 bg-slate-100 text-slate-500"
                          : "border-brand-600 bg-brand-50 text-slate-900"
                      } ${dragging ? "z-20 shadow-lg ring-2 ring-brand-600" : "z-10"} ${a.pending ? "opacity-60" : ""}`}
                      style={{
                        top: (shownStart - dayStartMin) * PX_PER_MIN,
                        height: Math.max(18, (shownEnd - shownStart) * PX_PER_MIN - 2),
                        touchAction: dragging ? "none" : "pan-y",
                        borderLeftColor: finished ? undefined : (a.doctor.color ?? undefined),
                      }}
                    >
                      <p className="truncate font-medium">{a.patient.name}</p>
                      <p className="truncate text-[11px] text-slate-600 tabular-nums">
                        {dragging
                          ? `${minutesToClock(shownStart)}–${minutesToClock(shownEnd)}`
                          : new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
                              timeZone: timezone,
                              hour: "numeric",
                              minute: "2-digit",
                            }).format(new Date(a.startsAt))}
                        {a.procedure ? ` · ${a.procedure.name}` : ""}
                      </p>
                      {editable && ["booked", "confirmed", "checked_in"].includes(a.status) ? (
                        <div
                          aria-hidden
                          className="absolute inset-x-0 bottom-0 h-3 cursor-ns-resize"
                          style={{ touchAction: "none" }}
                          onPointerDown={(e) => begin(e, a, "resize")}
                          onPointerMove={moveDrag}
                          onPointerUp={(e) => endDrag(e, a)}
                        />
                      ) : null}
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { displayPhone } from "../lib/format";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatClock, localDateOf, localMinutesOf, minutesToClock, zonedInstant } from "../lib/time";
import type { Appointment, AppointmentStatus, ClinicConfig } from "../lib/types";
import { Button, Field, Input, Select, Sheet, StatusBadge } from "./ui";

const NEXT_STEPS: Partial<Record<AppointmentStatus, { status: AppointmentStatus; key: string }[]>> = {
  booked: [
    { status: "checked_in", key: "checkIn" },
    { status: "confirmed", key: "confirm" },
    { status: "no_show", key: "noShow" },
  ],
  confirmed: [
    { status: "checked_in", key: "checkIn" },
    { status: "no_show", key: "noShow" },
  ],
  checked_in: [{ status: "in_chair", key: "inChair" }],
  in_chair: [{ status: "completed", key: "complete" }],
  no_show: [{ status: "booked", key: "reinstate" }],
};

export function nextSteps(status: AppointmentStatus) {
  return NEXT_STEPS[status] ?? [];
}

export function AppointmentSheet({
  appointment,
  config,
  canEdit,
  onClose,
  onStatus,
  onCancel,
  onMove,
  onCheckout,
}: {
  appointment: Appointment | null;
  config: ClinicConfig;
  canEdit: boolean;
  onClose: () => void;
  onStatus: (a: Appointment, s: AppointmentStatus) => Promise<void>;
  onCancel: (a: Appointment, reason?: string) => Promise<void>;
  onMove: (
    a: Appointment,
    change: { startsAt: string; endsAt: string; doctorId?: string; chairId?: string },
  ) => Promise<void>;
  /** Bill and payment for this visit (shown once the visit is done). */
  onCheckout?: (a: Appointment) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tz = config.clinic.timezone;
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [chairId, setChairId] = useState("");

  useEffect(() => {
    if (!appointment) return;
    setMode("view");
    setReason("");
    setDate(localDateOf(new Date(appointment.startsAt), tz));
    setTime(minutesToClock(localMinutesOf(new Date(appointment.startsAt), tz)));
    setDoctorId(appointment.doctor.id);
    setChairId(appointment.chair.id);
  }, [appointment, tz]);

  if (!appointment)
    return (
      <Sheet open={false} onClose={onClose} title="">
        {null}
      </Sheet>
    );
  const a = appointment;
  const durationMs = new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime();
  const procedureName = a.procedure
    ? locale === "hi" && a.procedure.nameHi
      ? a.procedure.nameHi
      : a.procedure.name
    : t("appointment.noProcedure");

  return (
    <Sheet open onClose={onClose} title={t("appointment.title")}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <Link
              href={`/patients/${a.patient.id}`}
              className="text-lg font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              {a.patient.name}
            </Link>
            {a.patient.phone ? (
              <p>
                <a href={`tel:${a.patient.phone}`} className="text-sm text-slate-600 underline">
                  {displayPhone(a.patient.phone)}
                </a>
              </p>
            ) : null}
          </div>
          <StatusBadge status={a.status} label={t(`status.${a.status}`)} />
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-500">{t("appointment.time")}</dt>
          <dd>
            {formatClock(a.startsAt, tz, locale)} – {formatClock(a.endsAt, tz, locale)}
          </dd>
          <dt className="text-slate-500">{t("appointment.procedure")}</dt>
          <dd>{procedureName}</dd>
          <dt className="text-slate-500">{t("appointment.doctor")}</dt>
          <dd>{config.doctors.find((d) => d.id === a.doctor.id)?.name ?? a.doctor.name}</dd>
          <dt className="text-slate-500">{t("appointment.chair")}</dt>
          <dd>{config.chairs.find((c) => c.id === a.chair.id)?.name ?? a.chair.name}</dd>
          {a.notes ? (
            <>
              <dt className="text-slate-500">{t("appointment.notes")}</dt>
              <dd>{a.notes}</dd>
            </>
          ) : null}
        </dl>

        {canEdit && mode === "view" ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {nextSteps(a.status).map((step) => (
                <Button
                  key={step.status}
                  variant={step.status === "no_show" || step.status === "confirmed" ? "secondary" : "primary"}
                  onClick={() => void onStatus(a, step.status).then(onClose)}
                >
                  {t(`actions.${step.key}`)}
                </Button>
              ))}
            </div>
            {onCheckout && a.status === "completed" ? (
              <Button className="w-full" onClick={() => onCheckout(a)}>
                {t("desk.checkout")}
              </Button>
            ) : null}
            {["booked", "confirmed", "checked_in"].includes(a.status) ? (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setMode("move")}>
                  {t("actions.move")}
                </Button>
                <Button variant="danger" onClick={() => setMode("cancel")}>
                  {t("actions.cancel")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === "cancel" ? (
          <div className="space-y-2">
            <Field label={t("actions.cancelReason")}>
              {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setMode("view")}>
                {t("common.back")}
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => void onCancel(a, reason || undefined).then(onClose)}
              >
                {t("actions.cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === "move" ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("appointment.date")}>
                {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
              <Field label={t("appointment.time")}>
                {(id) => (
                  <Input
                    id={id}
                    type="time"
                    step={config.clinic.slot_step_min * 60}
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("appointment.doctor")}>
                {(id) => (
                  <Select id={id} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                    {config.doctors
                      .filter((d) => d.active)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label={t("appointment.chair")}>
                {(id) => (
                  <Select id={id} value={chairId} onChange={(e) => setChairId(e.target.value)}>
                    {config.chairs
                      .filter((c) => c.active)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setMode("view")}>
                {t("common.back")}
              </Button>
              <Button
                className="flex-1"
                onClick={() => {
                  const [h, m] = time.split(":").map(Number) as [number, number];
                  const start = zonedInstant(date, h * 60 + m, tz);
                  void onMove(a, {
                    startsAt: start.toISOString(),
                    endsAt: new Date(start.getTime() + durationMs).toISOString(),
                    doctorId: doctorId !== a.doctor.id ? doctorId : undefined,
                    chairId: chairId !== a.chair.id ? chairId : undefined,
                  }).then(onClose);
                }}
              >
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

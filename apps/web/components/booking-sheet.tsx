"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { minutesToClock, zonedInstant } from "../lib/time";
import type { ClinicConfig, Patient } from "../lib/types";
import { PatientPicker } from "./patient-picker";
import { Button, Field, Input, Select, Sheet, Textarea } from "./ui";

export interface BookingDraft {
  date: string;
  startMin: number;
  doctorId?: string;
  chairId?: string;
  patient?: Patient | null;
}

export function BookingSheet({
  open,
  onClose,
  config,
  draft,
  onBook,
}: {
  open: boolean;
  onClose: () => void;
  config: ClinicConfig;
  draft: BookingDraft | null;
  onBook: (body: Record<string, unknown>, label: string) => Promise<boolean>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tz = config.clinic.timezone;
  const doctors = config.doctors.filter((d) => d.active);
  const chairs = config.chairs.filter((c) => c.active);
  const procedures = config.procedures.filter((p) => p.active);

  const [patient, setPatient] = useState<Patient | null>(null);
  const [procedureId, setProcedureId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [chairId, setChairId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(15);
  const [notes, setNotes] = useState("");
  const [walkIn, setWalkIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !draft) return;
    setPatient(draft.patient ?? null);
    setProcedureId("");
    setDoctorId(draft.doctorId ?? doctors[0]?.id ?? "");
    setChairId(draft.chairId ?? chairs[0]?.id ?? "");
    setDate(draft.date);
    setTime(minutesToClock(draft.startMin));
    setDuration(15);
    setNotes("");
    setWalkIn(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  const procedure = useMemo(() => procedures.find((p) => p.id === procedureId), [procedures, procedureId]);
  useEffect(() => {
    if (procedure) setDuration(procedure.default_duration_min);
  }, [procedure]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patient || !date || !time) return;
    const [h, m] = time.split(":").map(Number) as [number, number];
    const start = zonedInstant(date, h * 60 + m, tz);
    setBusy(true);
    const ok = await onBook(
      {
        patientId: patient.id,
        doctorId,
        chairId,
        procedureTypeId: procedureId || null,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + duration * 60_000).toISOString(),
        notes: notes || undefined,
        walkIn,
      },
      `${t("appointment.book")}: ${patient.name}`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  const name = (p: { name: string; name_hi: string | null }) =>
    locale === "hi" && p.name_hi ? p.name_hi : p.name;

  return (
    <Sheet open={open} onClose={onClose} title={t("appointment.new")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("appointment.patient")}>
          {() => <PatientPicker value={patient} onChange={setPatient} />}
        </Field>
        <Field label={t("appointment.procedure")}>
          {(id) => (
            <Select id={id} value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
              <option value="">{t("appointment.noProcedure")}</option>
              {procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {name(p)} · {t("common.minutes", { count: p.default_duration_min })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("appointment.doctor")}>
            {(id) => (
              <Select id={id} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                {doctors.map((d) => (
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
                {chairs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("appointment.date")}>
            {(id) => (
              <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            )}
          </Field>
          <Field label={t("appointment.time")}>
            {(id) => (
              <Input
                id={id}
                type="time"
                step={config.clinic.slot_step_min * 60}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label={t("appointment.duration")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={5}
                max={480}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            )}
          </Field>
          <label className="flex items-end gap-2 pb-3 text-sm">
            <input
              type="checkbox"
              checked={walkIn}
              onChange={(e) => setWalkIn(e.target.checked)}
              className="size-5"
            />
            {t("appointment.walkIn")}
          </label>
        </div>
        <Field label={t("appointment.notes")}>
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <Button type="submit" busy={busy} disabled={!patient}>
          {t("appointment.book")}
        </Button>
      </form>
    </Sheet>
  );
}

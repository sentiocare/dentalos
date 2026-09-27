"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import type { ClinicConfig, Patient } from "../lib/types";
import { PatientPicker } from "./patient-picker";
import { Button, Field, Input, Select, Sheet, useToast } from "./ui";

/** A patient walks in: find or add them, note what they need, give a token. They wait in the queue. */
export function WalkInSheet({
  open,
  onClose,
  config,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  config: ClinicConfig;
  onAdded: () => void;
}) {
  const t = useTranslations("desk");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api } = useSession();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [procedureId, setProcedureId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setPatient(null);
    setDoctorId("");
    setProcedureId("");
    setNote("");
    setToken(null);
  }, [open]);

  const save = async () => {
    if (!patient) return;
    setBusy(true);
    try {
      const r = await api<{ token: number }>("/v1/queue", {
        method: "POST",
        body: {
          patientId: patient.id,
          doctorId: doctorId || null,
          procedureTypeId: procedureId || null,
          note,
        },
      });
      setToken(r.token);
      onAdded();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("walkInTitle")}>
      {token !== null ? (
        <div className="space-y-4 text-center" data-testid="token-given">
          <p className="text-sm text-slate-600">{t("tokenFor", { name: patient?.name ?? "" })}</p>
          <p className="text-6xl font-bold text-brand-700 tabular-nums">{token}</p>
          <p className="text-sm text-slate-600">{t("tokenHelp")}</p>
          <Button className="w-full" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-slate-700">{t("patient")}</p>
            <PatientPicker value={patient} onChange={setPatient} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("doctor")}>
              {(id) => (
                <Select id={id} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                  <option value="">{t("anyDoctor")}</option>
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
            <Field label={t("forWhat")}>
              {(id) => (
                <Select id={id} value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
                  <option value="">{t("checkUp")}</option>
                  {config.procedures
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {locale === "hi" && p.name_hi ? p.name_hi : p.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label={t("note")}>
            {(id) => (
              <Input
                id={id}
                value={note}
                maxLength={300}
                placeholder={t("notePlaceholder")}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Button className="w-full" disabled={!patient} busy={busy} onClick={() => void save()}>
            {t("giveToken")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

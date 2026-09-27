"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { normalizePhone } from "@dentalos/shared/phone";
import type { Patient } from "../lib/types";
import { Button, Field, Input, Select, Textarea } from "./ui";

export type PatientFormValue = Partial<Omit<Patient, "id" | "lastVisitAt">>;

const SOURCES = ["walk_in", "referral", "google", "instagram", "practo", "justdial", "other"] as const;

export function PatientForm({
  initial,
  busy,
  onSubmit,
}: {
  initial?: Patient;
  busy?: boolean;
  onSubmit: (v: PatientFormValue) => void;
}) {
  const t = useTranslations("patients");
  const tc = useTranslations("common");
  const tl = useTranslations("login");
  const currentYear = new Date().getFullYear();
  const [v, setV] = useState<PatientFormValue>({
    name: initial?.name ?? "",
    phone: initial?.phone?.replace(/^\+91/, "") ?? "",
    altPhone: initial?.altPhone?.replace(/^\+91/, "") ?? "",
    gender: initial?.gender ?? "unknown",
    city: initial?.city ?? "",
    address: initial?.address ?? "",
    notes: initial?.notes ?? "",
    fileNumber: initial?.fileNumber ?? "",
    source: initial?.source ?? "",
    dob: initial?.dob ?? "",
  });
  const [age, setAge] = useState(
    initial?.approxBirthYear && !initial.dob ? String(currentYear - initial.approxBirthYear) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof PatientFormValue) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        for (const p of [v.phone, v.altPhone])
          if (p && !normalizePhone(p)) return setError(tl("invalidPhone"));
        setError(null);
        const blankToNull = (s?: string | null) => (s && s.trim() ? s.trim() : null);
        onSubmit({
          ...v,
          phone: blankToNull(v.phone),
          altPhone: blankToNull(v.altPhone),
          city: blankToNull(v.city),
          address: blankToNull(v.address),
          notes: blankToNull(v.notes),
          fileNumber: blankToNull(v.fileNumber),
          source: blankToNull(v.source),
          dob: blankToNull(v.dob),
          approxBirthYear: !v.dob && age ? currentYear - Number(age) : null,
        });
      }}
    >
      <Field label={t("name")}>
        {(id) => <Input id={id} value={v.name ?? ""} onChange={set("name")} required autoFocus={!initial} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("phone")} error={error ?? undefined}>
          {(id) => <Input id={id} type="tel" inputMode="tel" value={v.phone ?? ""} onChange={set("phone")} />}
        </Field>
        <Field label={t("altPhone")}>
          {(id) => (
            <Input id={id} type="tel" inputMode="tel" value={v.altPhone ?? ""} onChange={set("altPhone")} />
          )}
        </Field>
        <Field label={t("age")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={120}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              disabled={!!v.dob}
            />
          )}
        </Field>
        <Field label={t("dob")}>
          {(id) => <Input id={id} type="date" value={v.dob ?? ""} onChange={set("dob")} />}
        </Field>
        <Field label={t("gender")}>
          {(id) => (
            <Select id={id} value={v.gender} onChange={set("gender")}>
              {(["female", "male", "other", "unknown"] as const).map((g) => (
                <option key={g} value={g}>
                  {t(`genders.${g}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("fileNumber")}>
          {(id) => <Input id={id} value={v.fileNumber ?? ""} onChange={set("fileNumber")} />}
        </Field>
      </div>
      <Field label={t("city")}>{(id) => <Input id={id} value={v.city ?? ""} onChange={set("city")} />}</Field>
      <Field label={t("source")}>
        {(id) => (
          <Select id={id} value={v.source ?? ""} onChange={set("source")}>
            <option value="">—</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`sources.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t("notes")}>
        {(id) => <Textarea id={id} value={v.notes ?? ""} onChange={set("notes")} />}
      </Field>
      <Button type="submit" busy={busy}>
        {tc("save")}
      </Button>
    </form>
  );
}

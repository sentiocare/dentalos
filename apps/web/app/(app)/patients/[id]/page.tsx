"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BookingSheet, type BookingDraft } from "../../../../components/booking-sheet";
import { ConfirmWarnings } from "../../../../components/confirm-warnings";
import { PatientForm } from "../../../../components/patient-form";
import { PatientPicker } from "../../../../components/patient-picker";
import { Button, Card, Field, Input, Sheet, Spinner, StatusBadge, useToast } from "../../../../components/ui";
import { ApiError } from "../../../../lib/api";
import { useAppointmentActions } from "../../../../lib/appointment-actions";
import { useClinicConfig } from "../../../../lib/data";
import { useSession } from "../../../../lib/session";
import { formatClock, localDateOf, localMinutesOf, todayIn } from "../../../../lib/time";
import type { Patient } from "../../../../lib/types";

interface Detail {
  patient: Patient;
  family: {
    linkId: string;
    patientId: string;
    name: string;
    phone: string | null;
    relationship: string;
    direction: string;
  }[];
  appointments: {
    id: string;
    startsAt: string;
    status: string;
    doctorName: string;
    procedureName: string | null;
  }[];
}

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const { api, can } = useSession();
  const toast = useToast();
  const config = useClinicConfig();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [relative, setRelative] = useState<Patient | null>(null);
  const [relationship, setRelationship] = useState("");
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>(`/v1/patients/${id}`));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("common.error"), "error");
    }
  }, [api, id, t, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const noopSet = useCallback(() => {}, []);
  const actions = useAppointmentActions(noopSet, load);
  const tz = config.data?.clinic.timezone ?? "Asia/Kolkata";

  if (!detail) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const p = detail.patient;
  const age = p.dob
    ? new Date().getFullYear() - Number(p.dob.slice(0, 4))
    : p.approxBirthYear
      ? new Date().getFullYear() - p.approxBirthYear
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <Link href="/patients" className="text-sm text-brand-700">
        ‹ {t("patients.title")}
      </Link>
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">{p.name}</h1>
            <p className="text-sm text-slate-600">
              {[
                age !== null ? t("patients.years", { age }) : null,
                p.gender !== "unknown" ? t(`patients.genders.${p.gender}`) : null,
                p.city,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {p.phone ? (
              <a href={`tel:${p.phone}`} className="mt-1 inline-block text-brand-700 underline">
                {p.phone.replace("+91", "")}
              </a>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            {can("appointments.write") && config.data ? (
              <Button
                onClick={() =>
                  setDraft({
                    date: todayIn(tz),
                    startMin: Math.ceil(localMinutesOf(new Date(), tz) / 15) * 15,
                    patient: p,
                  })
                }
              >
                {t("patients.book")}
              </Button>
            ) : null}
            {can("patients.write") ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t("common.edit")}
              </Button>
            ) : null}
          </div>
        </div>
        {p.notes ? (
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm whitespace-pre-line">{p.notes}</p>
        ) : null}
        <p className="mt-3 text-xs text-slate-500">
          {t("patients.lastVisit")}:{" "}
          {p.lastVisitAt ? localDateOf(new Date(p.lastVisitAt), tz) : t("patients.never")}
          {p.fileNumber ? ` · ${t("patients.fileNumber")}: ${p.fileNumber}` : ""}
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">{t("patients.family")}</h2>
          {can("patients.write") ? (
            <button className="text-sm text-brand-700 underline" onClick={() => setLinking(true)}>
              + {t("patients.addFamily")}
            </button>
          ) : null}
        </div>
        {detail.family.length === 0 ? (
          <p className="text-sm text-slate-500">{t("patients.noFamily")}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.family.map((f) => (
              <li key={f.linkId}>
                <Link href={`/patients/${f.patientId}`} className="text-brand-700 underline">
                  {f.name}
                </Link>{" "}
                <span className="text-slate-500">({f.relationship})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{t("patients.history")}</h2>
        {detail.appointments.length === 0 ? (
          <p className="text-sm text-slate-500">{t("patients.noHistory")}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {detail.appointments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <p>
                    {localDateOf(new Date(a.startsAt), tz)} · {formatClock(a.startsAt, tz, locale)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {a.procedureName ?? t("appointment.noProcedure")} · {a.doctorName}
                  </p>
                </div>
                <StatusBadge status={a.status} label={t(`status.${a.status}`)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Sheet open={editing} onClose={() => setEditing(false)} title={t("common.edit")}>
        <PatientForm
          initial={p}
          busy={busy}
          onSubmit={async (value) => {
            setBusy(true);
            try {
              await api(`/v1/patients/${id}`, { method: "PATCH", body: value });
              setEditing(false);
              toast(t("common.saved"));
              await load();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : t("common.error"), "error");
            } finally {
              setBusy(false);
            }
          }}
        />
      </Sheet>

      <Sheet open={linking} onClose={() => setLinking(false)} title={t("patients.addFamily")}>
        <div className="space-y-3">
          <PatientPicker value={relative} onChange={setRelative} />
          <Field label={t("patients.relationship")}>
            {(fid) => (
              <Input id={fid} value={relationship} onChange={(e) => setRelationship(e.target.value)} />
            )}
          </Field>
          <Button
            className="w-full"
            disabled={!relative || !relationship.trim() || relative.id === p.id}
            onClick={async () => {
              try {
                await api(`/v1/patients/${id}/family`, {
                  method: "POST",
                  body: { relatedPatientId: relative!.id, relationship },
                });
                setLinking(false);
                setRelative(null);
                setRelationship("");
                await load();
              } catch (e) {
                toast(e instanceof ApiError ? e.message : t("common.error"), "error");
              }
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      </Sheet>

      {config.data ? (
        <BookingSheet
          open={!!draft}
          onClose={() => setDraft(null)}
          config={config.data}
          draft={draft}
          onBook={actions.book}
        />
      ) : null}
      <ConfirmWarnings confirmation={actions.confirmation} onClose={actions.clearConfirmation} />
    </div>
  );
}

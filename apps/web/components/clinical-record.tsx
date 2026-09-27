"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import { formatClock } from "../lib/time";
import { PrescriptionSheet, type RxItem } from "./prescription-sheet";
import { ToothChart, type Condition, type Finding } from "./tooth-chart";
import { Button, Card, Field, Select, Spinner, Textarea, useToast } from "./ui";

interface Note {
  id: string;
  appointmentId: string | null;
  complaint: string | null;
  findings: string | null;
  diagnosis: string | null;
  treatment: string | null;
  advice: string | null;
  doctorName: string | null;
  visitAt: string;
  procedureName: string | null;
  edited: boolean;
}
interface Prescription {
  id: string;
  number: string;
  items: RxItem[];
  advice: string | null;
  reviewOn: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  doctorName: string;
}
interface Record {
  notes: Note[];
  chart: { teeth: { [tooth: string]: Finding }; history: Finding[] };
  prescriptions: Prescription[];
}
export interface Visit {
  id: string;
  startsAt: string;
  status: string;
  doctorName: string;
  doctorId?: string;
  procedureName: string | null;
}

const FIELDS = ["complaint", "findings", "diagnosis", "treatment", "advice"] as const;
type NoteDraft = { [K in (typeof FIELDS)[number]]: string };
const EMPTY: NoteDraft = { complaint: "", findings: "", diagnosis: "", treatment: "", advice: "" };

/**
 * The doctor's side of the patient page: the note for a visit, the tooth chart, prescriptions, and every
 * earlier note. Staff without clinical access never see this section.
 */
export function ClinicalRecord({
  patient,
  visits,
  visitId,
  timezone,
  doctors,
}: {
  patient: { id: string; name: string; phone: string | null };
  visits: Visit[];
  visitId: string | null;
  timezone: string;
  doctors: { id: string; name: string }[];
}) {
  const t = useTranslations("clinical");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { api, can, openPdf } = useSession();
  const toast = useToast();
  const write = can("clinical.write");
  const [record, setRecord] = useState<Record | null>(null);
  const noteVisits = visits.filter((v) => ["checked_in", "in_chair", "completed"].includes(v.status));
  const [visit, setVisit] = useState<string>(visitId ?? noteVisits[0]?.id ?? "");
  const [draft, setDraft] = useState<NoteDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Record>(`/v1/patients/${patient.id}/clinical`);
    setRecord(r);
    return r;
  }, [api, patient.id]);
  useEffect(() => {
    void load().catch(() => toast(tc("error"), "error"));
  }, [load, tc, toast]);
  // The form shows the selected visit's note, if one was written.
  useEffect(() => {
    const existing = record?.notes.find((n) => n.appointmentId === (visit || null));
    setDraft(existing ? (Object.fromEntries(FIELDS.map((f) => [f, existing[f] ?? ""])) as NoteDraft) : EMPTY);
  }, [record, visit]);

  const when = (iso: string) => `${iso.slice(0, 10)} · ${formatClock(iso, timezone, locale)}`;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      toast(done);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const selected = visits.find((v) => v.id === visit);

  if (!record)
    return (
      <div className="flex justify-center py-8 text-slate-400">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-4" data-testid="clinical-record">
      {write ? (
        <Card>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t("visitNote")}</h2>
            <Select
              aria-label={t("visit")}
              className="min-h-9 w-auto text-sm"
              value={visit}
              onChange={(e) => setVisit(e.target.value)}
            >
              {noteVisits.map((v) => (
                <option key={v.id} value={v.id}>
                  {when(v.startsAt)} · {v.procedureName ?? t("visitWord")}
                </option>
              ))}
              <option value="">{t("noVisit")}</option>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <Field key={f} label={t(`fields.${f}`)}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    value={draft[f]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              busy={busy}
              disabled={FIELDS.every((f) => !draft[f].trim())}
              onClick={() =>
                void run(
                  () =>
                    api(`/v1/patients/${patient.id}/notes`, {
                      method: "POST",
                      body: {
                        ...draft,
                        appointmentId: visit || null,
                        doctorId: selected?.doctorId ?? null,
                      },
                    }),
                  t("noteSaved"),
                )
              }
            >
              {t("saveNote")}
            </Button>
            <Button variant="secondary" onClick={() => setWriting(true)}>
              {t("writeRx")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 font-semibold">{t("chart")}</h2>
        <ToothChart
          teeth={record.chart.teeth}
          history={record.chart.history}
          canWrite={write}
          onRecord={(input) =>
            run(
              () =>
                api(`/v1/patients/${patient.id}/teeth`, {
                  method: "POST",
                  body: { ...input, condition: input.condition as Condition, appointmentId: visit || null },
                }),
              t("toothSaved"),
            )
          }
        />
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{t("prescriptions")}</h2>
        {record.prescriptions.length === 0 ? <p className="text-sm text-slate-500">{t("noRx")}</p> : null}
        <ul className="divide-y divide-slate-100" data-testid="prescriptions">
          {record.prescriptions.map((rx) => (
            <li key={rx.id} className={`py-2 text-sm ${rx.cancelledAt ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {rx.number} · {rx.createdAt.slice(0, 10)} · {rx.doctorName}
                  </p>
                  <p className="text-slate-600">{rx.items.map((i) => i.drug).join(", ")}</p>
                  {rx.cancelledAt ? (
                    <p className="text-xs text-red-700">
                      {t("cancelled", { reason: rx.cancelReason ?? "" })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button
                    className="text-brand-700 underline"
                    onClick={() => void openPdf(`/v1/prescriptions/${rx.id}/pdf`).catch(() => {})}
                  >
                    {t("print")}
                  </button>
                  {!rx.cancelledAt && patient.phone ? (
                    <button
                      className="text-brand-700 underline"
                      onClick={() =>
                        void run(
                          () => api(`/v1/prescriptions/${rx.id}/send`, { method: "POST" }),
                          t("rxSentToast"),
                        )
                      }
                    >
                      {t("whatsapp")}
                    </button>
                  ) : null}
                  {!rx.cancelledAt && write ? (
                    <button
                      className="text-red-700 underline"
                      onClick={() => {
                        const reason = window.prompt(t("cancelReason"));
                        if (reason?.trim())
                          void run(
                            () =>
                              api(`/v1/prescriptions/${rx.id}/cancel`, { method: "POST", body: { reason } }),
                            t("rxCancelled"),
                          );
                      }}
                    >
                      {t("cancel")}
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">{t("history")}</h2>
        {record.notes.length === 0 ? <p className="text-sm text-slate-500">{t("noNotes")}</p> : null}
        <ol className="space-y-3">
          {record.notes.map((n) => (
            <li key={n.id} className="text-sm">
              <p className="text-xs font-medium text-slate-500">
                {when(n.visitAt)}
                {n.procedureName ? ` · ${n.procedureName}` : ""}
                {n.doctorName ? ` · ${n.doctorName}` : ""}
                {n.edited ? ` · ${t("edited")}` : ""}
              </p>
              <dl className="mt-0.5 space-y-0.5">
                {FIELDS.filter((f) => n[f]).map((f) => (
                  <div key={f} className="flex gap-2">
                    <dt className="w-24 shrink-0 text-slate-500">{t(`fields.${f}`)}</dt>
                    <dd className="whitespace-pre-line">{n[f]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      </Card>

      <PrescriptionSheet
        open={writing}
        onClose={() => setWriting(false)}
        patient={patient}
        doctors={doctors}
        defaultDoctorId={selected?.doctorId ?? null}
        appointmentId={visit || null}
        onSaved={() => void load()}
      />
    </div>
  );
}

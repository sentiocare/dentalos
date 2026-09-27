"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Card, EmptyState, Select, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import { readSpreadsheet } from "../../../lib/spreadsheet";

type Kind = "patients" | "appointments";
const PATIENT_FIELDS = [
  "name",
  "phone",
  "altPhone",
  "age",
  "dob",
  "gender",
  "city",
  "address",
  "fileNumber",
  "notes",
  "source",
];
const APPOINTMENT_FIELDS = [
  "date",
  "time",
  "endTime",
  "duration",
  "patientName",
  "phone",
  "doctor",
  "procedure",
  "chair",
  "notes",
];

interface PatientPreviewRow {
  row: number;
  value: Record<string, unknown> | null;
  issues: string[];
  duplicateOf?: { id: string; name: string };
  duplicateOfRow?: number;
  action: "create" | "merge" | "skip";
}
interface AppointmentPreviewRow {
  row: number;
  issues: string[];
  importable: boolean;
  value?: { date: string; startMin: number; patientName: string };
}

export default function ImportPage() {
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const { api, can } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("patients");
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [patientPreview, setPatientPreview] = useState<PatientPreviewRow[] | null>(null);
  const [apptPreview, setApptPreview] = useState<AppointmentPreviewRow[] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can("patients.import")) return <EmptyState>403</EmptyState>;

  const headers = rows?.[0] ? Object.keys(rows[0]) : [];
  const fields = kind === "patients" ? PATIENT_FIELDS : APPOINTMENT_FIELDS;

  async function runPreview(data: Record<string, string>[], map?: Record<string, string>) {
    setBusy(true);
    setResult(null);
    try {
      const res = await api<{ mapping: Record<string, string>; rows: unknown[] }>(
        `/v1/imports/${kind}/preview`,
        {
          method: "POST",
          body: { rows: data, ...(map ? { mapping: map } : {}) },
        },
      );
      setMapping(res.mapping);
      if (kind === "patients") setPatientPreview(res.rows as PatientPreviewRow[]);
      else setApptPreview(res.rows as AppointmentPreviewRow[]);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setPatientPreview(null);
    setApptPreview(null);
    try {
      const data = await readSpreadsheet(file);
      setRows(data);
      if (data.length) await runPreview(data);
    } catch {
      toast(tc("error"), "error");
    }
  }

  async function commit() {
    setBusy(true);
    try {
      if (kind === "patients" && patientPreview) {
        const r = await api<{ created: number; merged: number; skipped: number }>(
          "/v1/imports/patients/commit",
          {
            method: "POST",
            body: {
              decisions: patientPreview.map((p) => ({
                action: p.value ? p.action : "skip",
                value: p.value,
                mergeIntoId: p.duplicateOf?.id,
              })),
            },
          },
        );
        setResult(t("result", r));
        setPatientPreview(null);
      } else if (apptPreview) {
        const r = await api<{ status: string }[]>("/v1/imports/appointments/commit", {
          method: "POST",
          body: { rows: apptPreview },
        });
        const count = (s: string) => r.filter((x) => x.status === s).length;
        setResult(
          t("apptResult", {
            booked: count("booked"),
            conflict: count("conflict"),
            already: count("already_imported"),
            error: count("error"),
          }),
        );
        setApptPreview(null);
      }
      setRows(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  }

  const counts = patientPreview
    ? {
        create: patientPreview.filter((p) => p.action === "create").length,
        merge: patientPreview.filter((p) => p.action === "merge").length,
        skip: patientPreview.filter((p) => p.action === "skip").length,
      }
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex rounded-xl border border-slate-300 p-0.5 text-sm">
        {(["patients", "appointments"] as const).map((k) => (
          <button
            key={k}
            aria-pressed={kind === k}
            className="flex-1 rounded-lg px-3 py-2 aria-pressed:bg-brand-600 aria-pressed:text-white"
            onClick={() => {
              setKind(k);
              setRows(null);
              setPatientPreview(null);
              setApptPreview(null);
              setResult(null);
            }}
          >
            {t(k)}
          </button>
        ))}
      </div>
      <Card className="space-y-3">
        <p className="text-sm text-slate-600">{t("help")}</p>
        <label className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl bg-brand-600 px-4 text-sm font-medium text-white">
          {t("choose")}
          <input
            type="file"
            accept=".xlsx,.csv,text/csv"
            className="sr-only"
            data-testid="import-file"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>
      </Card>

      {result ? (
        <p
          className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          data-testid="import-result"
        >
          {result}
        </p>
      ) : null}

      {rows && headers.length ? (
        <Card className="space-y-3">
          <h2 className="font-semibold">{t("mapping")}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {fields.map((f) => (
              <label key={f} className="text-sm">
                <span className="text-slate-600">{t(`fields.${f}`)}</span>
                <Select
                  value={mapping[f] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}
                >
                  <option value="">{t("notUsed")}</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              void runPreview(rows, Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))
            }
          >
            {t("preview")}
          </Button>
        </Card>
      ) : null}

      {patientPreview && counts ? (
        <Card className="space-y-3">
          <p className="text-sm font-medium" data-testid="import-counts">
            {t("counts", counts)}
          </p>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {patientPreview.slice(0, 300).map((r, i) => (
                  <tr key={r.row}>
                    <td className="py-1 pr-2 text-slate-400 tabular-nums">{r.row}</td>
                    <td className="py-1 pr-2">
                      {String(r.value?.name ?? "—")}
                      <span className="block text-xs text-slate-500">
                        {String(r.value?.phone ?? "")}
                        {r.duplicateOf ? ` · ${t("duplicateOf", { name: r.duplicateOf.name })}` : ""}
                        {r.duplicateOfRow ? ` · ${t("duplicateRow", { row: r.duplicateOfRow })}` : ""}
                        {r.issues.length ? ` · ${r.issues.map((x) => t(`issues.${x}`)).join(", ")}` : ""}
                      </span>
                    </td>
                    <td className="py-1">
                      {r.value ? (
                        <Select
                          value={r.action}
                          className="min-h-9"
                          onChange={(e) => {
                            const next = [...patientPreview];
                            next[i] = { ...r, action: e.target.value as PatientPreviewRow["action"] };
                            setPatientPreview(next);
                          }}
                        >
                          <option value="create">{t("actions.create")}</option>
                          {r.duplicateOf ? <option value="merge">{t("actions.merge")}</option> : null}
                          <option value="skip">{t("actions.skip")}</option>
                        </Select>
                      ) : (
                        t("actions.skip")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button busy={busy} onClick={() => void commit()}>
            {t("commit")}
          </Button>
        </Card>
      ) : null}

      {apptPreview ? (
        <Card className="space-y-3">
          <p className="text-sm font-medium">
            {t("apptCounts", {
              ok: apptPreview.filter((r) => r.importable).length,
              bad: apptPreview.filter((r) => !r.importable).length,
            })}
          </p>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-auto text-sm">
            {apptPreview.slice(0, 300).map((r) => (
              <li key={r.row} className="py-1">
                <span className="text-slate-400 tabular-nums">{r.row}</span>{" "}
                {r.value ? `${r.value.date} · ${r.value.patientName}` : "—"}
                {r.issues.length ? (
                  <span className={r.importable ? "text-amber-700" : "text-red-700"}>
                    {" "}
                    · {r.issues.map((x) => t(`issues.${x}`)).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <Button busy={busy} onClick={() => void commit()}>
            {t("commit")}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

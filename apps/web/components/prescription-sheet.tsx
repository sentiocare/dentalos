"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Select, Sheet, Textarea, useToast } from "./ui";

export interface RxItem {
  drug: string;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  instructions?: string | null;
}
export interface RxTemplate {
  id: string;
  name: string;
  items: RxItem[];
  advice: string | null;
  doctorId: string | null;
}

// Typing aids for the doctor only (generic names, as prescriptions should use); nothing is suggested to
// patients, and the doctor writes or changes every line.
const DRUGS = [
  "Amoxicillin 500 mg",
  "Amoxicillin 500 mg + Clavulanic acid 125 mg",
  "Metronidazole 400 mg",
  "Azithromycin 500 mg",
  "Clindamycin 300 mg",
  "Ibuprofen 400 mg",
  "Paracetamol 650 mg",
  "Aceclofenac 100 mg + Paracetamol 325 mg",
  "Diclofenac 50 mg",
  "Ketorolac 10 mg",
  "Pantoprazole 40 mg",
  "Chlorhexidine 0.2% mouthwash",
  "Benzydamine mouthwash",
  "Potassium nitrate toothpaste",
  "Triamcinolone oral paste",
];
const FREQUENCIES = [
  "1-0-1",
  "1-1-1",
  "1-0-0",
  "0-0-1",
  "SOS (when needed)",
  "Twice a day",
  "Three times a day",
];
const DURATIONS = ["3 days", "5 days", "7 days", "2 weeks", "1 month"];
const INSTRUCTIONS = ["After food", "Before food", "Rinse for 1 minute, do not swallow", "Apply on the area"];
const EMPTY: RxItem = { drug: "", dose: "", frequency: "", duration: "", instructions: "" };

/** Writing a prescription: from a template or by hand, then print it or send it on WhatsApp. */
export function PrescriptionSheet({
  open,
  onClose,
  patient,
  doctors,
  defaultDoctorId,
  appointmentId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patient: { id: string; name: string; phone: string | null };
  doctors: { id: string; name: string }[];
  defaultDoctorId: string | null;
  appointmentId: string | null;
  onSaved: () => void;
}) {
  const t = useTranslations("clinical");
  const tc = useTranslations("common");
  const { api, openPdf } = useSession();
  const toast = useToast();
  const [templates, setTemplates] = useState<RxTemplate[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [items, setItems] = useState<RxItem[]>([{ ...EMPTY }]);
  const [advice, setAdvice] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [send, setSend] = useState(true);
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ id: string; number: string; sent: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDoctorId(defaultDoctorId ?? doctors[0]?.id ?? "");
    setItems([{ ...EMPTY }]);
    setAdvice("");
    setReviewOn("");
    setSend(!!patient.phone);
    setTemplateName("");
    setSaved(null);
    void api<RxTemplate[]>("/v1/rx-templates")
      .then(setTemplates)
      .catch(() => {});
  }, [open, api, defaultDoctorId, doctors, patient.phone]);

  const valid = items.filter((i) => i.drug.trim());
  const update = (i: number, change: Partial<RxItem>) =>
    setItems((list) => list.map((x, k) => (k === i ? { ...x, ...change } : x)));

  const save = async () => {
    if (!valid.length || !doctorId) return;
    setBusy(true);
    try {
      if (templateName.trim())
        await api("/v1/rx-templates", {
          method: "POST",
          body: { name: templateName.trim(), doctorId, items: valid, advice: advice || null },
        });
      const r = await api<{ id: string; number: string; sent: boolean }>(
        `/v1/patients/${patient.id}/prescriptions`,
        {
          method: "POST",
          body: {
            doctorId,
            appointmentId,
            items: valid,
            advice: advice || null,
            reviewOn: reviewOn || null,
            send,
          },
        },
      );
      setSaved(r);
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("newRx", { name: patient.name })}>
      {saved ? (
        <div className="space-y-3" data-testid="rx-saved">
          <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">
            {t("rxSaved", { number: saved.number })} {saved.sent ? t("rxSent") : ""}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              onClick={() => void openPdf(`/v1/prescriptions/${saved.id}/pdf`).catch(() => {})}
            >
              {t("print")}
            </Button>
            <Button onClick={onClose}>{tc("close")}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("doctor")}>
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
            <Field label={t("fromTemplate")}>
              {(id) => (
                <Select
                  id={id}
                  value=""
                  onChange={(e) => {
                    const tpl = templates.find((x) => x.id === e.target.value);
                    if (!tpl) return;
                    setItems(tpl.items.map((i) => ({ ...EMPTY, ...i })));
                    if (tpl.advice) setAdvice(tpl.advice);
                  }}
                >
                  <option value="">{templates.length ? t("chooseTemplate") : t("noTemplates")}</option>
                  {templates.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <ol className="space-y-2">
            {items.map((item, i) => (
              <li key={i} className="space-y-1.5 rounded-xl border border-slate-200 p-2">
                <div className="flex gap-2">
                  <Input
                    aria-label={t("medicine", { n: i + 1 })}
                    list="rx-drugs"
                    placeholder={t("medicinePlaceholder")}
                    value={item.drug}
                    onChange={(e) => update(i, { drug: e.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={tc("remove")}
                    className="px-1 text-slate-400 hover:text-red-600"
                    onClick={() =>
                      setItems((list) => (list.length > 1 ? list.filter((_, k) => k !== i) : [{ ...EMPTY }]))
                    }
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <Input
                    aria-label={t("dose")}
                    placeholder={t("dose")}
                    value={item.dose ?? ""}
                    onChange={(e) => update(i, { dose: e.target.value })}
                  />
                  <Input
                    aria-label={t("frequency")}
                    list="rx-frequency"
                    placeholder={t("frequency")}
                    value={item.frequency ?? ""}
                    onChange={(e) => update(i, { frequency: e.target.value })}
                  />
                  <Input
                    aria-label={t("duration")}
                    list="rx-duration"
                    placeholder={t("duration")}
                    value={item.duration ?? ""}
                    onChange={(e) => update(i, { duration: e.target.value })}
                  />
                </div>
                <Input
                  aria-label={t("instructions")}
                  list="rx-instructions"
                  placeholder={t("instructions")}
                  value={item.instructions ?? ""}
                  onChange={(e) => update(i, { instructions: e.target.value })}
                />
              </li>
            ))}
          </ol>
          {items.length < 10 ? (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setItems((list) => [...list, { ...EMPTY }])}
            >
              + {t("addMedicine")}
            </Button>
          ) : null}
          <datalist id="rx-drugs">
            {DRUGS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <datalist id="rx-frequency">
            {FREQUENCIES.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <datalist id="rx-duration">
            {DURATIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <datalist id="rx-instructions">
            {INSTRUCTIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>

          <Field label={t("advice")}>
            {(id) => <Textarea id={id} rows={2} value={advice} onChange={(e) => setAdvice(e.target.value)} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("reviewOn")}>
              {(id) => (
                <Input id={id} type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />
              )}
            </Field>
            <Field label={t("saveAsTemplate")}>
              {(id) => (
                <Input
                  id={id}
                  placeholder={t("templateNamePlaceholder")}
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              )}
            </Field>
          </div>
          {patient.phone ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={send}
                onChange={(e) => setSend(e.target.checked)}
              />
              {t("sendOnWhatsApp")}
            </label>
          ) : null}
          <p className="text-xs text-slate-500">{t("rxFinal")}</p>
          <Button
            className="w-full"
            busy={busy}
            disabled={!valid.length || !doctorId}
            onClick={() => void save()}
          >
            {t("saveRx")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

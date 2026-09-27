"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Field, Input, Sheet } from "./ui";

export const CONDITIONS = [
  "healthy",
  "caries",
  "filled",
  "rct",
  "crown",
  "missing",
  "implant",
  "bridge",
  "mobile",
  "fractured",
  "impacted",
  "to_extract",
  "other",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface Finding {
  id: string;
  tooth: number;
  condition: Condition;
  surfaces: string | null;
  note: string | null;
  recordedAt: string;
  recordedBy: string | null;
}

const COLORS: Record<Condition, string> = {
  healthy: "bg-white text-slate-700 ring-slate-300",
  caries: "bg-amber-200 text-amber-950 ring-amber-400",
  filled: "bg-sky-200 text-sky-950 ring-sky-400",
  rct: "bg-violet-200 text-violet-950 ring-violet-400",
  crown: "bg-yellow-100 text-yellow-950 ring-yellow-500",
  missing: "bg-slate-200 text-slate-400 line-through ring-slate-300",
  implant: "bg-emerald-200 text-emerald-950 ring-emerald-500",
  bridge: "bg-teal-100 text-teal-950 ring-teal-500",
  mobile: "bg-rose-100 text-rose-900 ring-rose-300",
  fractured: "bg-rose-200 text-rose-950 ring-rose-400",
  impacted: "bg-orange-200 text-orange-950 ring-orange-400",
  to_extract: "bg-red-600 text-white ring-red-700",
  other: "bg-slate-100 text-slate-800 ring-slate-400",
};

// FDI numbering, drawn as the dentist faces the patient: patient's right on the left.
const ADULT = [
  [18, 17, 16, 15, 14, 13, 12, 11],
  [21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41],
  [31, 32, 33, 34, 35, 36, 37, 38],
];
const CHILD = [
  [55, 54, 53, 52, 51],
  [61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81],
  [71, 72, 73, 74, 75],
];

/** The tooth chart: each tooth coloured by its latest finding; tap a tooth to record what was found. */
export function ToothChart({
  teeth,
  history,
  canWrite,
  onRecord,
}: {
  teeth: Record<string, Finding>;
  history: Finding[];
  canWrite: boolean;
  onRecord: (input: {
    tooth: number;
    condition: Condition;
    surfaces: string;
    note: string;
  }) => Promise<boolean>;
}) {
  const t = useTranslations("clinical");
  const [child, setChild] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [condition, setCondition] = useState<Condition>("caries");
  const [surfaces, setSurfaces] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const layout = child ? CHILD : ADULT;
  const used = new Set(Object.values(teeth).map((f) => f.condition));

  const pick = (tooth: number) => {
    setOpen(tooth);
    setCondition(teeth[tooth]?.condition ?? "caries");
    setSurfaces("");
    setNote("");
  };

  return (
    <div className="space-y-2" data-testid="tooth-chart">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{t("chartHelp")}</p>
        <div className="flex shrink-0 rounded-full bg-slate-100 p-0.5 text-xs" role="tablist">
          {[false, true].map((c) => (
            <button
              key={String(c)}
              role="tab"
              aria-selected={child === c}
              onClick={() => setChild(c)}
              className={`rounded-full px-2.5 py-1 ${child === c ? "bg-white font-medium shadow-sm" : "text-slate-600"}`}
            >
              {t(c ? "child" : "adult")}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
        {layout.map((quadrant, qi) => (
          <div
            key={qi}
            className={`flex gap-1 ${qi % 2 === 0 ? "sm:justify-end" : ""} ${qi === 2 ? "sm:border-t sm:border-slate-300 sm:pt-1" : ""} ${qi === 3 ? "sm:border-t sm:border-slate-300 sm:pt-1" : ""}`}
          >
            {quadrant.map((n) => {
              const f = teeth[n];
              return (
                <button
                  key={n}
                  type="button"
                  disabled={!canWrite && !f}
                  onClick={() => pick(n)}
                  aria-label={
                    f ? t("toothIs", { n, condition: t(`conditions.${f.condition}`) }) : t("tooth", { n })
                  }
                  className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-md text-xs font-medium tabular-nums ring-1 sm:max-w-9 ${COLORS[f?.condition ?? "healthy"]}`}
                >
                  {n}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {used.size ? (
        <ul className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
          {[...used].map((c) => (
            <li key={c} className={`rounded px-1.5 py-0.5 ring-1 ${COLORS[c]}`}>
              {t(`conditions.${c}`)}
            </li>
          ))}
        </ul>
      ) : null}

      <Sheet open={open !== null} onClose={() => setOpen(null)} title={t("tooth", { n: open ?? 0 })}>
        {open !== null ? (
          <div className="space-y-3">
            {canWrite ? (
              <>
                <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t("condition")}>
                  {CONDITIONS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={condition === c}
                      onClick={() => setCondition(c)}
                      className={`min-h-9 rounded-lg px-1 text-xs ring-1 ${condition === c ? "ring-2 ring-brand-600" : ""} ${COLORS[c]}`}
                    >
                      {t(`conditions.${c}`)}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t("surfaces")}>
                    {(id) => (
                      <Input
                        id={id}
                        value={surfaces}
                        maxLength={6}
                        placeholder="MOD"
                        onChange={(e) => setSurfaces(e.target.value)}
                      />
                    )}
                  </Field>
                  <div className="col-span-2">
                    <Field label={t("toothNote")}>
                      {(id) => (
                        <Input
                          id={id}
                          value={note}
                          maxLength={300}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                </div>
                <Button
                  className="w-full"
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    const ok = await onRecord({ tooth: open, condition, surfaces, note });
                    setBusy(false);
                    if (ok) setOpen(null);
                  }}
                >
                  {t("saveTooth")}
                </Button>
              </>
            ) : null}
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {t("toothHistory")}
              </h3>
              <ul className="mt-1 space-y-1 text-sm">
                {history
                  .filter((f) => f.tooth === open)
                  .map((f) => (
                    <li key={f.id} className="flex justify-between gap-2">
                      <span>
                        {t(`conditions.${f.condition}`)}
                        {f.surfaces ? ` (${f.surfaces})` : ""}
                        {f.note ? ` · ${f.note}` : ""}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">{f.recordedAt.slice(0, 10)}</span>
                    </li>
                  ))}
                {!history.some((f) => f.tooth === open) ? (
                  <li className="text-slate-500">{t("nothingRecorded")}</li>
                ) : null}
              </ul>
            </section>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

"use client";

import { displayPhone } from "../../../lib/format";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { PatientForm } from "../../../components/patient-form";
import { Button, EmptyState, Input, Sheet, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import type { Patient } from "../../../lib/types";

export default function PatientsPage() {
  const t = useTranslations();
  const { api, can } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Patient[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Patient[]>(`/v1/patients?q=${encodeURIComponent(q)}&limit=50`, { signal: controller.signal })
        .then(setResults)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, api]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("patients.title")}</h1>
        {can("patients.write") ? (
          <Button onClick={() => setAdding(true)}>+ {t("patients.new")}</Button>
        ) : null}
      </div>
      <Input
        type="search"
        placeholder={t("patients.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("patients.search")}
      />
      {results && results.length === 0 ? <EmptyState>{t("common.noResults")}</EmptyState> : null}
      <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
        {results?.map((p) => (
          <li key={p.id}>
            <Link
              href={`/patients/${p.id}`}
              className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="text-xs text-slate-500">
                  {displayPhone(p.phone) || "—"}
                  {p.fileNumber ? ` · ${p.fileNumber}` : ""}
                </p>
              </div>
              <span className="text-slate-300">›</span>
            </Link>
          </li>
        ))}
      </ul>
      <Sheet open={adding} onClose={() => setAdding(false)} title={t("patients.new")}>
        <PatientForm
          busy={busy}
          onSubmit={async (value) => {
            setBusy(true);
            try {
              const p = await api<Patient>("/v1/patients", { method: "POST", body: value });
              router.push(`/patients/${p.id}`);
            } catch (e) {
              toast(e instanceof ApiError ? e.message : t("common.error"), "error");
            } finally {
              setBusy(false);
            }
          }}
        />
      </Sheet>
    </div>
  );
}

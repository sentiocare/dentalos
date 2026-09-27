"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { normalizePhone } from "@dentalos/shared/phone";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import type { Patient } from "../lib/types";
import { Button, Input, useToast } from "./ui";

/** Search-as-you-type patient selector with a quick "new patient" form (name + mobile). */
export function PatientPicker({
  value,
  onChange,
}: {
  value: Patient | null;
  onChange: (p: Patient | null) => void;
}) {
  const t = useTranslations();
  const { api } = useSession();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (value || creating) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Patient[]>(`/v1/patients?q=${encodeURIComponent(q)}&limit=8`, { signal: controller.signal })
        .then(setResults)
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, api, value, creating]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-brand-600 bg-brand-50 px-3 py-2">
        <div>
          <p className="font-medium">{value.name}</p>
          <p className="text-xs text-slate-600">{value.phone ?? "—"}</p>
        </div>
        <button type="button" className="text-sm text-brand-700 underline" onClick={() => onChange(null)}>
          {t("common.edit")}
        </button>
      </div>
    );
  }

  if (creating) {
    return (
      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <Input
          placeholder={t("patients.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Input
          placeholder={t("patients.phone")}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={() => setCreating(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="flex-1"
            busy={busy}
            disabled={!name.trim()}
            onClick={async () => {
              if (phone && !normalizePhone(phone)) return toast(t("login.invalidPhone"), "error");
              setBusy(true);
              try {
                const p = await api<Patient>("/v1/patients", {
                  method: "POST",
                  body: { name, phone: phone || null, source: "walk_in" },
                });
                onChange(p);
                setCreating(false);
              } catch (e) {
                toast(e instanceof ApiError ? e.message : t("common.error"), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.add")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder={t("appointment.choosePatient")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        type="search"
      />
      <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
        {results.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => onChange(p)}
            >
              <span>{p.name}</span>
              <span className="text-xs text-slate-500">{p.phone?.replace("+91", "") ?? ""}</span>
            </button>
          </li>
        ))}
        {results.length === 0 ? (
          <li className="px-3 py-2 text-sm text-slate-500">{t("common.noResults")}</li>
        ) : null}
      </ul>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={() => {
          setCreating(true);
          if (/\d{4,}/.test(q)) setPhone(q);
          else setName(q);
        }}
      >
        + {t("appointment.newPatient")}
      </Button>
    </div>
  );
}

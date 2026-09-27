"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { displayPhone } from "../lib/format";
import { useSession } from "../lib/session";
import type { Patient } from "../lib/types";

/**
 * Find a patient from anywhere: name, mobile (any part) or file number. "/" jumps here from any screen, so
 * the desk can look someone up while the phone is still ringing.
 */
export function GlobalSearch({ autoFocus, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const t = useTranslations("search");
  const { api, can } = useSession();
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Patient[]>(`/v1/patients?q=${encodeURIComponent(q.trim())}&limit=8`, { signal: controller.signal })
        .then((r) => {
          setResults(r);
          setActive(0);
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, api]);

  if (!can("patients.read")) return null;

  const go = (p: Patient) => {
    setQ("");
    setOpen(false);
    ref.current?.blur();
    onDone?.();
    router.push(`/patients/${p.id}`);
  };

  return (
    <div className="relative w-full">
      <input
        ref={ref}
        type="search"
        autoFocus={autoFocus}
        value={q}
        aria-label={t("label")}
        placeholder={t("placeholder")}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter" && results[active]) go(results[active]);
          else if (e.key === "Escape") {
            setOpen(false);
            ref.current?.blur();
            onDone?.();
          }
        }}
        className="min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 focus:outline-none"
      />
      {open && q.trim().length >= 2 ? (
        <ul
          role="listbox"
          aria-label={t("results")}
          className="absolute inset-x-0 top-full z-40 mt-1 max-h-96 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {results.length === 0 ? <li className="px-3 py-2 text-sm text-slate-500">{t("none")}</li> : null}
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(p)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${i === active ? "bg-brand-50" : ""}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {[displayPhone(p.phone), p.fileNumber].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="text-slate-300">›</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input, Spinner, useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
import { displayPhone } from "../../../lib/format";
import { useSession } from "../../../lib/session";

interface Step {
  key: string;
  required: boolean;
  href: string;
  ticked: boolean;
  done: boolean;
}
export interface Setup {
  steps: Step[];
  done: number;
  total: number;
  ready: boolean;
  testMode: { on: boolean; phones: string[] };
}

const OPERATORS = ["jio", "airtel", "vi", "bsnl", "landline"] as const;

/** The owner's setup checklist (PLAN Phase 6): every step, where to do it, test mode and call forwarding. */
export default function SetupPage() {
  const t = useTranslations("setup");
  const tc = useTranslations("common");
  const { api, can } = useSession();
  const toast = useToast();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [number, setNumber] = useState<string | null>(null);
  const [extra, setExtra] = useState("");
  const manage = can("settings.manage");

  const load = useCallback(() => {
    void api<Setup>("/v1/setup")
      .then((s) => {
        setSetup(s);
        setExtra(s.testMode.phones.map(displayPhone).join(", "));
      })
      .catch(() => {});
    void api<{ virtualNumber: string | null }>("/v1/voice")
      .then((v) => setNumber(v.virtualNumber))
      .catch(() => {});
  }, [api]);
  useEffect(() => {
    if (manage) load();
  }, [manage, load]);

  const put = async (path: string, body: unknown) => {
    const before = setup;
    try {
      const r = await api<Setup | Setup["testMode"]>(path, { method: "PUT", body });
      toast(tc("saved"));
      if ("steps" in r) setSetup(r);
      else load();
    } catch (e) {
      setSetup(before);
      toast(e instanceof ApiError ? e.message : tc("error"), "error");
    }
  };

  if (!manage) return <p className="p-4 text-sm text-slate-600">{t("ownerOnly")}</p>;
  if (!setup) return <Spinner />;
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <div>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-slate-600">
          {setup.ready ? t("ready") : t("progress", { done: setup.done, total: setup.total })}
        </p>
        <div className="mt-2 h-2 rounded-full bg-slate-200" aria-hidden>
          <div
            className="h-2 rounded-full bg-emerald-500"
            style={{ width: `${Math.round((setup.done / setup.total) * 100)}%` }}
          />
        </div>
      </div>

      <Card>
        <h2 className="font-semibold">{t("testMode.title")}</h2>
        <p className="mb-2 text-sm text-slate-600">{t("testMode.help")}</p>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5"
            checked={setup.testMode.on}
            onChange={(e) => {
              const on = e.target.checked;
              setSetup({ ...setup, testMode: { ...setup.testMode, on } });
              void put("/v1/test-mode", { on, phones: setup.testMode.phones });
            }}
          />
          {t("testMode.on")}
        </label>
        {setup.testMode.on ? (
          <div className="mt-2 flex gap-2">
            <Input
              aria-label={t("testMode.phones")}
              placeholder={t("testMode.phones")}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={() =>
                put("/v1/test-mode", {
                  on: true,
                  phones: extra
                    .split(",")
                    .map((p) => p.trim())
                    .filter(Boolean),
                })
              }
            >
              {tc("save")}
            </Button>
          </div>
        ) : null}
      </Card>

      <ol className="space-y-2" data-testid="setup-steps">
        {setup.steps.map((s, i) => (
          <li
            key={s.key}
            className={`flex items-start gap-3 rounded-2xl border p-3 ${s.done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}
          >
            <span
              className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"}`}
              role="img"
              aria-label={s.done ? t("doneLabel") : t("todoLabel")}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {t(`steps.${s.key}.title`)}
                {s.required ? null : <span className="ml-1 text-xs text-slate-500">({t("optional")})</span>}
              </p>
              <p className="text-sm text-slate-600">{t(`steps.${s.key}.help`)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
                <Link href={s.href} className="text-brand-700 underline">
                  {t("open")}
                </Link>
                {s.ticked ? (
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={s.done}
                      onChange={(e) => {
                        const done = e.target.checked;
                        // Shown at once; the server's answer replaces it (or the old state comes back on error).
                        setSetup({
                          ...setup,
                          steps: setup.steps.map((x) => (x.key === s.key ? { ...x, done } : x)),
                        });
                        void put(`/v1/setup/steps/${s.key}`, { done });
                      }}
                    />
                    {t("tick")}
                  </label>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <Forwarding number={number} />
    </div>
  );
}

/** Call forwarding, per operator. Forwarding only when busy, unanswered or unreachable keeps staff first. */
function Forwarding({ number }: { number: string | null }) {
  const t = useTranslations("setup.forwarding");
  const [op, setOp] = useState<(typeof OPERATORS)[number]>("jio");
  const n = number ? number.replace(/^\+91/, "0") : null;
  const code = (prefix: string) => (n ? `${prefix}${n}#` : `${prefix}<${t("number")}>#`);
  const codes = [
    { label: t("noAnswer"), code: code("**61*") },
    { label: t("busy"), code: code("**67*") },
    { label: t("unreachable"), code: code("**62*") },
  ];
  return (
    <Card>
      <h2 id="forwarding" className="scroll-mt-16 font-semibold">
        {t("title")}
      </h2>
      <p className="mb-2 text-sm text-slate-600">
        {number ? t("intro", { number: displayPhone(number) }) : t("noNumber")}
      </p>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {OPERATORS.map((o) => (
          <button
            key={o}
            role="tab"
            aria-selected={op === o}
            onClick={() => setOp(o)}
            className={`rounded-full px-3 py-1 text-sm ${op === o ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"}`}
          >
            {t(`operators.${o}`)}
          </button>
        ))}
      </div>
      {op === "landline" ? (
        <p className="text-sm">{t("landline")}</p>
      ) : (
        <>
          <p className="mb-2 text-sm">{t("dialEach")}</p>
          <ul className="space-y-1.5 text-sm">
            {codes.map((c) => (
              <li key={c.label} className="flex items-center justify-between gap-2">
                <span>{c.label}</span>
                <a
                  href={n ? `tel:${c.code.replace(/#/g, "%23")}` : undefined}
                  className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-slate-900"
                >
                  {c.code}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-slate-600">{t(`notes.${op}`)}</p>
          <p className="mt-1 text-sm text-slate-600">{t("check")}</p>
        </>
      )}
      <p className="mt-2 text-xs text-slate-500">{t("cost")}</p>
    </Card>
  );
}

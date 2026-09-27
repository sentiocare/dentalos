"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Spinner } from "../../../components/ui";
import { useSession } from "../../../lib/session";

interface Entry {
  id: number;
  at: string;
  actor: string;
  actor_name: string | null;
  action: "insert" | "update" | "delete";
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const IGNORED = new Set(["updated_at", "created_at", "id", "clinic_id"]);

function describe(e: Entry): string {
  const row = e.after ?? e.before ?? {};
  const label = (row.name ?? row.display_name ?? "") as string;
  if (e.action !== "update" || !e.before || !e.after) return label;
  const changed = Object.keys(e.after).filter(
    (k) => !IGNORED.has(k) && JSON.stringify(e.after![k]) !== JSON.stringify(e.before![k]),
  );
  return [label, changed.length ? `(${changed.join(", ")})` : ""].filter(Boolean).join(" ");
}

export default function ActivityPage() {
  const t = useTranslations("activity");
  const locale = useLocale();
  const { api } = useSession();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      const page = await api<Entry[]>(`/v1/audit?limit=50${before ? `&before=${before}` : ""}`);
      setEntries((current) => (before ? [...(current ?? []), ...page] : page));
      setDone(page.length < 50);
    },
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!entries) {
    return (
      <div className="flex justify-center py-12 text-slate-400">
        <Spinner />
      </div>
    );
  }
  const fmt = new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      {entries.length === 0 ? <EmptyState>{t("empty")}</EmptyState> : null}
      <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm">
        {entries.map((e) => (
          <li key={e.id} className="px-4 py-3">
            <p>
              <span className="font-medium">
                {e.actor_name ?? (e.actor.startsWith("user:") ? "—" : t("system"))}
              </span>{" "}
              {t(e.action)} {t.has(`entities.${e.entity}`) ? t(`entities.${e.entity}`) : e.entity}{" "}
              <span className="text-slate-600">{describe(e)}</span>
            </p>
            <p className="text-xs text-slate-500">{fmt.format(new Date(e.at))}</p>
          </li>
        ))}
      </ul>
      {!done && entries.length ? (
        <Button variant="secondary" className="w-full" onClick={() => void load(entries.at(-1)!.id)}>
          {t("more")}
        </Button>
      ) : null}
    </div>
  );
}

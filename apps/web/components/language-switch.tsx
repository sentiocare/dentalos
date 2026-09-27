"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLanguage } from "../app/actions";
import { useSession } from "../lib/session";

const NAMES = { en: "English", hi: "हिन्दी" } as const;

/** Switches the UI language on this device and remembers it on the staff member's profile. */
export function LanguageSwitch() {
  const locale = useLocale();
  const router = useRouter();
  const { api, status } = useSession();
  const [pending, start] = useTransition();

  function choose(next: "en" | "hi") {
    const form = new FormData();
    form.set("locale", next);
    start(async () => {
      await setLanguage(form);
      if (status === "ready")
        void api("/v1/me", { method: "PATCH", body: { uiLanguage: next } }).catch(() => {});
      router.refresh();
    });
  }

  return (
    <div className="flex gap-1" role="group">
      {(Object.keys(NAMES) as (keyof typeof NAMES)[]).map((l) => (
        <button
          key={l}
          type="button"
          disabled={pending}
          aria-pressed={l === locale}
          onClick={() => choose(l)}
          className="rounded-full border border-slate-300 px-3 py-1 text-sm aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-pressed:text-brand-700"
        >
          {NAMES[l]}
        </button>
      ))}
    </div>
  );
}

import { getLocale, getTranslations } from "next-intl/server";
import { LOCALES } from "../i18n/config";
import { setLanguage } from "./actions";

const LANGUAGE_NAMES = { en: "English", hi: "हिन्दी" } as const;

export default async function Home() {
  const t = await getTranslations();
  const locale = await getLocale();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-brand-700">{t("app.name")}</h1>
        <form action={setLanguage} className="flex gap-1" aria-label={t("home.language")}>
          {LOCALES.map((l) => (
            <button
              key={l}
              name="locale"
              value={l}
              aria-pressed={l === locale}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-pressed:text-brand-700"
            >
              {LANGUAGE_NAMES[l]}
            </button>
          ))}
        </form>
      </header>
      <p className="text-slate-600">{t("app.tagline")}</p>
      <section className="rounded-2xl border border-slate-200 p-4">
        <h2 className="font-medium">{t("home.setupTitle")}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("home.setupBody")}</p>
      </section>
    </main>
  );
}

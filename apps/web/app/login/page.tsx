"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { LanguageSwitch } from "../../components/language-switch";
import { Button, Field, Input } from "../../components/ui";
import { useSession } from "../../lib/session";

export default function LoginPage() {
  const t = useTranslations("login");
  const ta = useTranslations("app");
  const session = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === "ready" || session.status === "no_clinic") router.replace("/today");
  }, [session.status, router]);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setError(t("invalidEmail"));
    setBusy(true);
    setError(null);
    try {
      await session.driver.requestOtp(address);
      setStep("code");
    } catch {
      setError(t("invalidEmail"));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.driver.verifyOtp(email.trim().toLowerCase(), code.trim());
      await session.refresh();
    } catch {
      setError(t("wrongCode"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-700">{ta("name")}</h1>
        <LanguageSwitch />
      </div>
      <p className="text-sm text-slate-600">{ta("tagline")}</p>
      {step === "email" ? (
        <form onSubmit={sendCode} className="flex flex-col gap-4">
          <Field label={t("emailLabel")} error={error ?? undefined}>
            {(id) => (
              <Input
                id={id}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" busy={busy}>
            {t("sendOtp")}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-4">
          <Field
            label={t("otpLabel")}
            error={error ?? undefined}
            hint={session.driver.kind === "dev" ? t("devNote") : undefined}
          >
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" busy={busy}>
            {t("verify")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStep("email")}>
            {t("changeEmail")}
          </Button>
        </form>
      )}
    </main>
  );
}

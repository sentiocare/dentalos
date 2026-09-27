"use client";

import { displayPhone } from "../../../lib/format";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LanguageSwitch } from "../../../components/language-switch";
import { Button, Card } from "../../../components/ui";
import { useSession } from "../../../lib/session";

export default function MorePage() {
  const t = useTranslations("nav");
  const session = useSession();
  const links = [
    { href: "/import", label: t("import"), show: session.can("patients.import") },
    { href: "/settings", label: t("settings"), show: true },
    { href: "/activity", label: t("activity"), show: session.can("audit.read") },
  ];
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-4">
      <Card>
        <p className="font-semibold">{session.clinic?.displayName}</p>
        <p className="text-sm text-slate-500">{displayPhone(session.me?.user.phone)}</p>
      </Card>
      <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
        {links
          .filter((l) => l.show)
          .map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex justify-between px-4 py-3 hover:bg-slate-50">
                {l.label} <span className="text-slate-300">›</span>
              </Link>
            </li>
          ))}
      </ul>
      <Card className="flex items-center justify-between">
        <span className="text-sm">{t("language")}</span>
        <LanguageSwitch />
      </Card>
      {session.me && session.me.clinics.length > 1 ? (
        <Card className="space-y-2">
          <p className="text-sm font-medium">{t("switchClinic")}</p>
          {session.me.clinics.map((c) => (
            <Button
              key={c.id}
              variant={c.id === session.clinic?.id ? "primary" : "secondary"}
              className="w-full"
              onClick={() => session.selectClinic(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </Card>
      ) : null}
      <Button variant="danger" className="w-full" onClick={() => void session.signOut()}>
        {t("signOut")}
      </Button>
    </div>
  );
}

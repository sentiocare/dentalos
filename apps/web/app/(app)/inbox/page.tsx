"use client";

import { useTranslations } from "next-intl";
import { InboxList } from "../../../components/inbox-list";
import { useWide } from "../../../lib/use-wide";

export default function InboxPage() {
  const t = useTranslations("inbox");
  if (useWide())
    return <p className="flex h-full items-center justify-center text-sm text-slate-500">{t("pickChat")}</p>;
  return (
    <div className="mx-auto max-w-2xl">
      <InboxList />
    </div>
  );
}

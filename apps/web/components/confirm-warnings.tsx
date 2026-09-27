"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { PendingConfirmation } from "../lib/appointment-actions";
import { Button, Sheet } from "./ui";

export function ConfirmWarnings({
  confirmation,
  onClose,
}: {
  confirmation: PendingConfirmation | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={!!confirmation} onClose={onClose} title={t("calendar.warningsTitle")}>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {confirmation?.warnings.map((w) => (
          <li key={w}>{t(`warnings.${w}`)}</li>
        ))}
      </ul>
      <p className="mb-4 text-sm">{t("calendar.warningsBody")}</p>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          className="flex-1"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            const retry = confirmation?.retry;
            onClose();
            await retry?.();
            setBusy(false);
          }}
        >
          {t("calendar.bookAnyway")}
        </Button>
      </div>
    </Sheet>
  );
}

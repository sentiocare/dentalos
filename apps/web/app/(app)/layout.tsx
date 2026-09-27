"use client";

import type { ReactNode } from "react";
import { AppShell } from "../../components/app-shell";
import { OutboxProvider } from "../../lib/outbox";

export default function SignedInLayout({ children }: { children: ReactNode }) {
  return (
    <OutboxProvider>
      <AppShell>{children}</AppShell>
    </OutboxProvider>
  );
}

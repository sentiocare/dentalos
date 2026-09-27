"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { InboxList } from "../../../components/inbox-list";
import { useWide } from "../../../lib/use-wide";

/** Desk computers: the chat list stays on the left while a chat is open on the right. */
export default function InboxLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ id?: string }>();
  const wide = useWide();
  if (!wide) return <>{children}</>;
  return (
    <div className="grid h-[calc(100dvh-3.6rem)] grid-cols-[22rem_1fr]">
      <aside className="overflow-y-auto border-r border-slate-200">
        <InboxList activeId={params.id} />
      </aside>
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

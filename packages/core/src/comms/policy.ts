import { localMinutesOf, zonedInstant, addDays, localDateOf } from "../time";

/**
 * The single gate every outgoing message passes (PLAN §5.2). Pure function: the caller supplies facts.
 */
export type Category = "service" | "transactional" | "promotional" | "critical";

export interface ContactFacts {
  category: Category;
  channel: "whatsapp" | "sms";
  now: Date;
  timezone: string;
  /** Active opt-outs for this number. */
  optOuts: { channel: string; category: string }[];
  /** Latest marketing consent (promotional only). */
  marketingConsent: boolean;
  /** When the patient last wrote to us (WhatsApp 24-hour window). */
  lastInboundAt: Date | null;
  /** Whether an approved template exists for this message (needed outside the window). */
  hasApprovedTemplate: boolean;
  /** Allowed hours for business-initiated messages, "HH:MM". */
  hours: { transactional: [string, string]; promotional: [string, string] };
}

export type ContactDecision =
  { allow: true; mode: "free_form" | "template" } | { allow: false; reason: ContactDenial; retryAt?: Date };

export type ContactDenial =
  "opted_out" | "no_marketing_consent" | "quiet_hours" | "outside_window_no_template";

/** WhatsApp allows free-form messages for 24 hours after the patient's last message; keep a safety margin. */
export const WINDOW_MS = 24 * 60 * 60_000 - 10 * 60_000;

/** Defaults (ASSUMPTIONS A-7, A-25): utility reminders 07:00–21:30, promotions 09:00–20:00, clinic time. */
export const DEFAULT_HOURS: ContactFacts["hours"] = {
  transactional: ["07:00", "21:30"],
  promotional: ["09:00", "20:00"],
};

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export function decideContact(f: ContactFacts): ContactDecision {
  const windowOpen = f.lastInboundAt !== null && f.now.getTime() - f.lastInboundAt.getTime() < WINDOW_MS;

  if (f.category !== "critical" && f.category !== "service") {
    const blocked = f.optOuts.some(
      (o) =>
        (o.channel === "all" || o.channel === f.channel) &&
        (o.category === "all" || o.category === f.category),
    );
    if (blocked) return { allow: false, reason: "opted_out" };
  }
  if (f.category === "promotional" && !f.marketingConsent)
    return { allow: false, reason: "no_marketing_consent" };

  if (f.category === "transactional" || f.category === "promotional") {
    const [start, end] = f.hours[f.category].map(toMin) as [number, number];
    const minutes = localMinutesOf(f.now, f.timezone);
    if (minutes < start || minutes >= end) {
      const today = localDateOf(f.now, f.timezone);
      const retryAt = zonedInstant(minutes < start ? today : addDays(today, 1), start, f.timezone);
      return { allow: false, reason: "quiet_hours", retryAt };
    }
  }

  // Replies to the patient (service) are only possible inside the window by definition.
  if (windowOpen) return { allow: true, mode: "free_form" };
  if (f.category === "service") return { allow: false, reason: "outside_window_no_template" };
  if (f.hasApprovedTemplate) return { allow: true, mode: "template" };
  return { allow: false, reason: "outside_window_no_template" };
}

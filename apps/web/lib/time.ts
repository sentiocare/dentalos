import {
  addDays,
  localDateOf,
  localMinutesOf,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from "@dentalos/core/time";

export { addDays, localDateOf, localMinutesOf, weekdayOf, zonedInstant, type LocalDate };

export function todayIn(timezone: string): LocalDate {
  return localDateOf(new Date(), timezone);
}

export function dayRange(date: LocalDate, timezone: string) {
  return {
    from: zonedInstant(date, 0, timezone).toISOString(),
    to: zonedInstant(addDays(date, 1), 0, timezone).toISOString(),
    key: date,
  };
}

export function formatClock(iso: string | Date, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

export function formatDay(date: LocalDate, locale: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: "UTC",
    weekday: style,
    day: "numeric",
    month: style === "long" ? "long" : "short",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function formatRupees(paise: number | null | undefined, locale: string): string {
  if (paise === null || paise === undefined) return "—";
  return new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

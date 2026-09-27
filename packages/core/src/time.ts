/**
 * Clinic-local date and time helpers. Dates are "YYYY-MM-DD" strings in the clinic's time zone; times are
 * "HH:MM" (or "HH:MM:SS" as Postgres returns them). Instants are JS Dates (UTC).
 * India has no daylight saving, but the helpers work for any IANA zone.
 */

export type LocalDate = string;

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  date: LocalDate;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  return zonedParts(instant, timeZone).date;
}

/** Minutes since local midnight. */
export function localMinutesOf(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" or "HH:MM:SS" → minutes since midnight. */
export function parseTime(time: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) throw new RangeError(`Invalid time: ${time}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes > 24 * 60) throw new RangeError(`Invalid time: ${time}`);
  return minutes;
}

export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const [y, mo, d] = p.date.split("-").map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the clinic's wall clock shows `date` + `minutes` after midnight. */
export function zonedInstant(date: LocalDate, minutes: number, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, mo - 1, d, 0, minutes);
  let guess = naive - offsetMs(new Date(naive), timeZone);
  // Second pass handles zones whose offset differs on either side of a transition.
  guess = naive - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** 0 = Sunday … 6 = Saturday, matching the database and JS getDay(). */
export function weekdayOf(date: LocalDate): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function isLocalDate(value: string): value is LocalDate {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

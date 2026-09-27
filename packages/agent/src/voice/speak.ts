import { addDays, clockInWords, dayInWords, localDateOf, localMinutesOf } from "@dentalos/core";
import type { VoiceLang } from "./copy";

/**
 * Appointment times the way they are said on the phone:
 *   hi  "कल शाम साढ़े 5 बजे", "सोमवार, 6 अक्टूबर, सुबह 10 बजे"
 *   en  "tomorrow at 5:30 PM", "Monday, 6 October at 10 AM"
 */
export function spokenWhen(instant: Date, timezone: string, lang: VoiceLang, now: Date): string {
  const date = localDateOf(instant, timezone);
  const today = localDateOf(now, timezone);
  const relative =
    date === today
      ? lang === "hi"
        ? "आज"
        : "today"
      : date === addDays(today, 1)
        ? lang === "hi"
          ? "कल"
          : "tomorrow"
        : null;
  if (lang === "hi")
    return `${relative ?? `${dayInWords(instant, timezone, "hi")},`} ${clockInWords(instant, timezone, "hi")}`;
  return `${relative ?? dayInWords(instant, timezone, "en")} at ${spokenClockEn(localMinutesOf(instant, timezone))}`;
}

export function spokenClockEn(minutes: number): string {
  const h = ((Math.floor(minutes / 60) + 11) % 12) + 1;
  const m = minutes % 60;
  return `${h}${m ? `:${String(m).padStart(2, "0")}` : ""} ${minutes < 720 ? "AM" : "PM"}`;
}

export function spokenClock(minutes: number, lang: VoiceLang): string {
  if (lang === "en") return spokenClockEn(minutes);
  // Reuse the Hindi clock words ("शाम साढ़े 5 बजे") via a fixed date.
  const instant = new Date(Date.UTC(2030, 0, 7, 0, minutes) - 330 * 60_000);
  return clockInWords(instant, "Asia/Kolkata", "hi");
}

/** "₹1,500" is read oddly by speech engines; say "1500" and let the sentence add "rupees". */
export const spokenRupees = (paise: number) => String(Math.round(paise / 100));

/** "a, b and c" / "a, b और c". */
export function spokenList(items: string[], lang: VoiceLang): string {
  if (items.length <= 1) return items[0] ?? "";
  const and = lang === "hi" ? "और" : "and";
  return `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
}

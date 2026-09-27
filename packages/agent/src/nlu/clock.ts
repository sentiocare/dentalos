import { romanize } from "./romanize";

/**
 * The time of day a caller asks for, in clinic-local minutes: "5 baje", "shaam saadhe 5", "10:30",
 * "subah 11 baje", "5 pm", "sawa 6", "paune 7", "dedh baje". Returns null when no time is mentioned.
 * Without am/pm or a part of the day, 1–8 means afternoon/evening (clinics are not open at 5 am).
 */
export function parseClockPreference(text: string): number | null {
  const t = ` ${romanize(text)
    .toLowerCase()
    .replace(/[^a-z0-9:.\s]/g, " ")
    .replace(/\s+/g, " ")} `;
  let hour: number | null = null;
  let minute = 0;
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{1,2})[:.](\d{2})\b/.exec(t))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if ((m = /\b(saadhe|sadhe|saade|half past)\s+(\d{1,2})\b/.exec(t))) {
    hour = Number(m[2]);
    minute = 30;
  } else if ((m = /\b(sawa|quarter past)\s+(\d{1,2})\b/.exec(t))) {
    hour = Number(m[2]);
    minute = 15;
  } else if ((m = /\b(paune|pone|quarter to)\s+(\d{1,2})\b/.exec(t))) {
    hour = Number(m[2]) - 1;
    minute = 45;
  } else if (/\bdedh\b/.test(t)) {
    hour = 1;
    minute = 30;
  } else if (/\b(dhaai|dhai)\b/.test(t)) {
    hour = 2;
    minute = 30;
  } else if ((m = /\b(\d{1,2})\s*(baje|bje|o ?clock|am|pm|a m|p m)\b/.exec(t))) {
    hour = Number(m[1]);
  }
  if (hour === null || hour > 23 || minute > 59) return null;
  const pm = /\b(pm|p m|shaam|sham|evening|raat|night|dopahar|dopehar|afternoon)\b/.test(t);
  const am = /\b(am|a m|subah|morning)\b/.test(t);
  if (hour <= 12) {
    if (pm && hour < 12) hour += 12;
    else if (am && hour === 12) hour = 0;
    else if (!am && !pm && hour >= 1 && hour <= 8) hour += 12;
  }
  return hour * 60 + minute;
}

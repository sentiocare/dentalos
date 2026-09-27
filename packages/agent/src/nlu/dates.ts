import { addDays, weekdayOf, type LocalDate, type PartOfDay } from "@dentalos/core";

/**
 * Understands when the patient wants to come: "kal", "parso", "aaj", "tomorrow", "next Tuesday",
 * "agle mangalvaar", "is hafte", "14 Oct", "14/10", "Sunday". Returns a clinic-local date range to search.
 */
export interface DatePreference {
  fromDate: LocalDate;
  toDate: LocalDate;
  /** The phrase that was understood, for logs and tests. */
  matched: string;
}

const WEEKDAYS: [RegExp, number][] = [
  [/\b(sunday|sun|ravivar|ravivaar|itwar|itvaar|रविवार|इतवार)\b/i, 0],
  [/\b(monday|mon|somvar|somvaar|सोमवार)\b/i, 1],
  [/\b(tuesday|tue|tues|mangalvar|mangalvaar|mangal|मंगलवार)\b/i, 2],
  [/\b(wednesday|wed|budhvar|budhvaar|budh|बुधवार)\b/i, 3],
  [/\b(thursday|thu|thurs|guruvar|guruvaar|brihaspativar|गुरुवार)\b/i, 4],
  [/\b(friday|fri|shukravar|shukravaar|shukra|शुक्रवार)\b/i, 5],
  [/\b(saturday|sat|shanivar|shanivaar|shani|शनिवार)\b/i, 6],
];

const MONTHS: [RegExp, number][] = [
  [/\b(jan|january|जनवरी)\b/i, 1],
  [/\b(feb|february|फ़रवरी|फरवरी)\b/i, 2],
  [/\b(mar|march|मार्च)\b/i, 3],
  [/\b(apr|april|अप्रैल)\b/i, 4],
  [/\b(may|मई)\b/i, 5],
  [/\b(jun|june|जून)\b/i, 6],
  [/\b(jul|july|जुलाई)\b/i, 7],
  [/\b(aug|august|अगस्त)\b/i, 8],
  [/\b(sep|sept|september|सितंबर)\b/i, 9],
  [/\b(oct|october|अक्टूबर)\b/i, 10],
  [/\b(nov|november|नवंबर)\b/i, 11],
  [/\b(dec|december|दिसंबर)\b/i, 12],
];

function single(date: LocalDate, matched: string): DatePreference {
  return { fromDate: date, toDate: date, matched };
}

function nextDateFor(today: LocalDate, month: number, day: number): LocalDate | null {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const check = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;
    if (iso >= today) return iso;
  }
  return null;
}

export function parseDatePreference(text: string, today: LocalDate): DatePreference | null {
  const t = text.toLowerCase();

  if (/\b(day after tomorrow|parso|parson|परसों)\b/i.test(t) || t.includes("परसों"))
    return single(addDays(today, 2), "day_after_tomorrow");
  if (/\b(today|aaj|abhi|आज)\b/i.test(t) || t.includes("आज")) return single(today, "today");
  if (/\b(tomorrow|tmrw|kal|कल)\b/i.test(t) || t.includes("कल")) return single(addDays(today, 1), "tomorrow");

  // "14 Oct", "14 October", "Oct 14", "14/10", "14-10"
  for (const [re, month] of MONTHS) {
    const m = new RegExp(
      `(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*${re.source}|${re.source}\\s*(\\d{1,2})`,
      "i",
    ).exec(t);
    if (m) {
      const day = Number(m[1] ?? m[m.length - 1]);
      const date = nextDateFor(today, month, day);
      if (date) return single(date, "calendar_date");
    }
  }
  const numeric = /\b(\d{1,2})[/-](\d{1,2})\b/.exec(t);
  if (numeric) {
    const date = nextDateFor(today, Number(numeric[2]), Number(numeric[1]));
    if (date) return single(date, "calendar_date");
  }

  const next = /\b(next|agle|agla|agli|aane wale)\b/i.test(t) || /(अगले|अगला)/.test(t);
  for (const [re, weekday] of WEEKDAYS) {
    if (!re.test(t)) continue;
    let diff = (weekday - weekdayOf(today) + 7) % 7;
    if (diff === 0) diff = next ? 7 : 0;
    else if (next && diff < 7 && /\bnext week\b/i.test(t)) diff += 7;
    return single(addDays(today, diff), next ? "next_weekday" : "weekday");
  }

  if (/\b(next week|agle hafte|agle week|अगले हफ्ते)\b/i.test(t)) {
    const toMonday = (8 - weekdayOf(today)) % 7 || 7;
    const from = addDays(today, toMonday);
    return { fromDate: from, toDate: addDays(from, 5), matched: "next_week" };
  }
  if (/\b(this week|is hafte|isi hafte|इस हफ्ते)\b/i.test(t)) {
    const toSaturday = (6 - weekdayOf(today) + 7) % 7;
    return { fromDate: today, toDate: addDays(today, toSaturday), matched: "this_week" };
  }
  if (/\b(weekend)\b/i.test(t)) {
    const toSaturday = (6 - weekdayOf(today) + 7) % 7;
    return {
      fromDate: addDays(today, toSaturday),
      toDate: addDays(today, toSaturday + 1),
      matched: "weekend",
    };
  }
  return null;
}

export function parsePartsOfDay(text: string): PartOfDay[] | null {
  const t = text.toLowerCase();
  const parts = new Set<PartOfDay>();
  if (/\b(morning|subah|savere|सुबह)\b/i.test(t) || t.includes("सुबह")) parts.add("morning");
  if (/\b(afternoon|dopahar|dopeher|lunch|दोपहर)\b/i.test(t) || t.includes("दोपहर")) parts.add("afternoon");
  if (/\b(evening|shaam|sham|night|raat|शाम|रात)\b/i.test(t) || t.includes("शाम") || t.includes("रात"))
    parts.add("evening");
  return parts.size ? [...parts] : null;
}

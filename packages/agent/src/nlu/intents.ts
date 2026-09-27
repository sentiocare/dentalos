import type { LLMProvider } from "@dentalos/adapters";
import type { LocalDate, PartOfDay } from "@dentalos/core";
import { z } from "zod";
import { parseDatePreference, parsePartsOfDay, type DatePreference } from "./dates";

export type Intent =
  | "book"
  | "reschedule"
  | "cancel"
  | "check_appointment"
  | "timings"
  | "location"
  | "price"
  | "doctors"
  | "human"
  | "bot_question"
  | "stop"
  | "start"
  | "greeting"
  | "thanks"
  | "yes"
  | "no"
  | "other";

export interface ProcedureOption {
  id: string;
  code: string;
  names: string[];
}

export interface Understanding {
  intent: Intent;
  procedureId: string | null;
  date: DatePreference | null;
  partsOfDay: PartOfDay[] | null;
  /** "mother", "son"… when booking for someone else. */
  relationship: string | null;
  /** A choice among numbered options: "2", "doosra", "second". */
  choice: number | null;
  source: "rules" | "llm";
}

const INTENT_RULES: [Intent, RegExp][] = [
  [
    "stop",
    /^\s*(stop|unsubscribe|stop messages?|band karo|message (mat|na) bhejo|mat bhejo|रोकें|बंद करें|बंद करो)\s*[.!]*\s*$/i,
  ],
  ["start", /^\s*(start|resume|shuru|शुरू)\s*[.!]*\s*$/i],
  [
    "bot_question",
    /\b(are you|r u|kya (aap|tum))\s+(a\s+)?(bot|robot|human|real|machine|insaan|asli)|\b(bot|robot|machine)\s+(ho|hai)\b|(रोबोट|मशीन)\s*(हो|है)/i,
  ],
  [
    "human",
    /\b(human|real person|staff|receptionist|reception|manager|insaan|kisi se baat|baat karni|baat karna|call (me|karo|kijiye|back)|phone (karo|kijiye)|callback|doctor se baat)\b|(किसी से बात|बात करनी|कॉल करें|फ़ोन करें)/i,
  ],
  [
    "cancel",
    /\b(cancel|radd|nahi aa (paunga|paungi|payenge|sakta|sakti|sakenge)|won'?t be able to come|can'?t come)\b|(रद्द|कैंसल)/i,
  ],
  [
    "reschedule",
    /\b(reschedule|re-schedule|postpone|prepone|change (the )?(time|date|appointment)|(time|date|samay|din) (change|badal|badalna)|badalna|aage (kar|badha)|shift)\b|(समय बदल|तारीख बदल)/i,
  ],
  [
    "check_appointment",
    /\b(my appointment|appointment (kab|kitne baje|ka time|status)|kab hai (mera|meri)|mera appointment|booking status|when is my)\b|(मेरा अपॉइंटमेंट|अपॉइंटमेंट कब)/i,
  ],
  [
    "price",
    /\b(price|cost|charges?|fees?|rate|kitna|kitne ka|kitne ki|kharcha|kharch|paisa|paise|rupees?|₹|emi)\b|(कितना|कितने का|खर्च|फीस|कीमत)/i,
  ],
  [
    "timings",
    /\b(timing|timings|open|close|closed|khula|khuli|band hai|kab tak|kitne baje (khul|band)|hours|holiday|chhutti|sunday ko)\b|(खुला|बंद है|कितने बजे|छुट्टी|टाइमिंग)/i,
  ],
  [
    "location",
    /\b(address|location|where|kaha|kahan|direction|directions|map|rasta|raasta|parking|kidhar)\b|(पता|कहाँ|कहां|रास्ता|पार्किंग)/i,
  ],
  [
    "doctors",
    /\b(which doctor|kaun (se|sa) doctor|doctor( sahab| saheb| sir| madam)?( aaj| kal| abhi)?\s*(hai|hain|aaye|aaenge|available|milenge)|orthodontist|braces wale|specialist|doctor aaj)\b|(डॉक्टर (साहब )?(हैं|आए|मिलेंगे))/i,
  ],
  [
    "book",
    /\b(book|booking|appointment|appt|slot|milna|dikhana|dikhane|checkup|check up|check-up|consult|consultation|aana hai|aa sakta|aa sakti|time chahiye|samay chahiye|karwana|karwani|karana|lagwana|nikalwana)\b|(अपॉइंटमेंट|दिखाना|बुक|समय चाहिए)/i,
  ],
  [
    "greeting",
    /^\s*(hi+|hello|hey|namaste|namaskar|good (morning|afternoon|evening)|नमस्ते|नमस्कार|हेलो)(?=[\s!.,]|$)/i,
  ],
  ["thanks", /\b(thanks|thank you|thx|shukriya|dhanyavad|dhanyawad|धन्यवाद|शुक्रिया)\b/i],
  [
    "yes",
    /^\s*(yes|y|yeah|yep|ok|okay|haan|han|haa|ha|ji|ji haan|theek|thik|sahi|confirm|pakka|done|हाँ|हां|जी|ठीक)\s*[.!]*\s*$/i,
  ],
  ["no", /^\s*(no|n|nope|nahi|nahin|na|mat|नहीं|ना)\s*[.!]*\s*$/i],
];

const RELATIONS: [RegExp, string][] = [
  [/\b(papa|pita|father|dad|daddy|पापा|पिता)\b/i, "father"],
  [/\b(mummy|mumma|maa|mother|mom|mata|माँ|मम्मी)\b/i, "mother"],
  [/\b(beta|son|बेटा)\b/i, "son"],
  [/\b(beti|daughter|बेटी)\b/i, "daughter"],
  [/\b(wife|patni|biwi|पत्नी)\b/i, "wife"],
  [/\b(husband|pati|पति)\b/i, "husband"],
  [/\b(bhai|brother|भाई)\b/i, "brother"],
  [/\b(behen|behan|sister|बहन)\b/i, "sister"],
  [/\b(dadi|nani|grandmother|दादी|नानी)\b/i, "grandmother"],
  [/\b(dada|nana|grandfather|दादा|नाना)\b/i, "grandfather"],
  [/\b(bachche|bachcha|child|kid|बच्चा|बच्चे)\b/i, "child"],
];

const CHOICES: [RegExp, number][] = [
  [/^\s*(1|one|first|pehla|pahla|pehle wala|पहला)\s*$/i, 1],
  [/^\s*(2|two|second|doosra|dusra|doosre wala|दूसरा)\s*$/i, 2],
  [/^\s*(3|three|third|teesra|tisra|तीसरा)\s*$/i, 3],
];

function normalise(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Finds a clinic procedure mentioned in the text by its name, code or the synonyms staff entered. */
export function matchProcedure(text: string, procedures: ProcedureOption[]): string | null {
  const t = ` ${normalise(text)} `;
  let best: { id: string; length: number } | null = null;
  for (const p of procedures) {
    for (const name of [...p.names, p.code.replace(/_/g, " ")]) {
      const n = normalise(name);
      if (n.length >= 3 && t.includes(` ${n} `) && (!best || n.length > best.length))
        best = { id: p.id, length: n.length };
    }
  }
  return best?.id ?? null;
}

export function understandByRules(
  text: string,
  today: LocalDate,
  procedures: ProcedureOption[],
): Understanding {
  const intent = INTENT_RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
  const procedureId = matchProcedure(text, procedures);
  const date = parseDatePreference(text, today);
  const partsOfDay = parsePartsOfDay(text);
  const relationship = RELATIONS.find(([re]) => re.test(text))?.[1] ?? null;
  const choice = CHOICES.find(([re]) => re.test(text))?.[1] ?? null;
  // "RCT karwana hai kal" is a booking even without the word "appointment".
  const inferred: Intent = intent === "other" && (procedureId || date) ? "book" : intent;
  return { intent: inferred, procedureId, date, partsOfDay, relationship, choice, source: "rules" };
}

const LlmUnderstanding = z.object({
  intent: z.enum([
    "book",
    "reschedule",
    "cancel",
    "check_appointment",
    "timings",
    "location",
    "price",
    "doctors",
    "human",
    "bot_question",
    "greeting",
    "thanks",
    "other",
  ]),
  treatment_words: z.string().nullable(),
  when_words: z.string().nullable(),
  part_of_day: z.enum(["morning", "afternoon", "evening"]).nullable(),
  for_relationship: z.string().nullable(),
});

const SYSTEM = `You classify WhatsApp messages sent to an Indian dental clinic's front desk. Messages may be in English, Hindi (Devanagari) or Hinglish (Hindi in Roman script), often informal and misspelt.
Return JSON only. Fields:
- intent: what the sender wants. "book" = new appointment; "reschedule" = move an existing one; "cancel"; "check_appointment" = ask when their appointment is; "timings" = opening hours/holidays; "location" = address/directions/parking; "price" = cost/fees/EMI; "doctors" = which doctor/when a doctor is available; "human" = wants a person/call back; "bot_question" = asks if this is a bot; "greeting"; "thanks"; "other".
- treatment_words: the words naming a dental treatment or problem, copied from the message, else null.
- when_words: the words naming a day or date, copied from the message (e.g. "kal", "next Tuesday", "14 Oct"), else null.
- part_of_day: morning/afternoon/evening if mentioned, else null.
- for_relationship: if booking for someone else, their relation to the sender in English (e.g. "mother", "son"), else null.
Do not give medical advice. Do not guess; use null when unsure.`;

/**
 * Rules first (fast, free, predictable). The model is asked only when rules find no intent, and its answer
 * is mapped back through the same date and procedure matchers, so it cannot invent a date or treatment.
 */
export async function understand(
  text: string,
  ctx: { today: LocalDate; procedures: ProcedureOption[]; llm?: LLMProvider },
): Promise<Understanding> {
  const rules = understandByRules(text, ctx.today, ctx.procedures);
  if (rules.intent !== "other" || !ctx.llm || text.trim().split(/\s+/).length < 2) return rules;
  try {
    const result = await ctx.llm.extract({
      system: SYSTEM,
      input: text.slice(0, 1000),
      schema: LlmUnderstanding,
      maxTokens: 400,
      purpose: "whatsapp_nlu",
    });
    if (!result.data) return rules;
    const d = result.data;
    return {
      intent: d.intent,
      procedureId:
        rules.procedureId ?? (d.treatment_words ? matchProcedure(d.treatment_words, ctx.procedures) : null),
      date: rules.date ?? (d.when_words ? parseDatePreference(d.when_words, ctx.today) : null),
      partsOfDay: rules.partsOfDay ?? (d.part_of_day ? [d.part_of_day] : null),
      relationship: rules.relationship ?? d.for_relationship,
      choice: rules.choice,
      source: "llm",
    };
  } catch {
    // Model slow or down: carry on with what the rules understood (Build Prompt §11).
    return rules;
  }
}

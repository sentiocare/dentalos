import { hasDevanagari, romanize } from "../nlu/romanize";

/**
 * Emergency detection on every patient message (Build Prompt §6.6). Deterministic keyword rules in English,
 * Hinglish and Hindi; an LLM classifier can only add detections, never remove them (ASSUMPTIONS A-15:
 * a false alarm costs far less than a missed emergency). Clinics can add their own trigger phrases.
 */
export type EmergencyLevel = "none" | "urgent" | "life_threatening";

export interface EmergencyResult {
  level: EmergencyLevel;
  triggers: string[];
}

interface Rule {
  trigger: string;
  level: Exclude<EmergencyLevel, "none">;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    trigger: "breathing_difficulty",
    level: "life_threatening",
    patterns: [
      /\b(can'?t|cannot|difficulty|trouble|hard to)\s+breath/i,
      /\bbreathless|short(ness)? of breath\b/i,
      /\bsaa?ns\s+(lene\s+m(e|ei|ein)\s+)?(dikkat|takleef|taklif|problem|nahi|phool|fool|ruk)/i,
      /(साँस|सांस)\s*(लेने में)?\s*(दिक्कत|तकलीफ|नहीं|फूल)/,
    ],
  },
  {
    trigger: "swallowing_difficulty",
    level: "life_threatening",
    patterns: [
      /\b(can'?t|cannot|difficulty|trouble|hard to)\s+swallow/i,
      /\bnigal(ne)?\s+(m(e|ei|ein)\s+)?(nahi|dikkat|takleef|problem)/i,
      /\b(khana|pani|paani|thook)\s+(nahi\s+)?(nigal|andar)\s*(nahi)?\s*(ja|pa)/i,
      /निगल(ने)?\s*(में)?\s*(नहीं|दिक्कत|तकलीफ)/,
    ],
  },
  {
    trigger: "unconscious_or_seizure",
    level: "life_threatening",
    patterns: [
      /\b(unconscious|fainted|seizure|fits)\b/i,
      /\b(behosh|daura|chakkar kha kar gir)\b/i,
      /(बेहोश|दौरा)/,
    ],
  },
  {
    trigger: "facial_swelling",
    level: "urgent",
    patterns: [
      /\b(face|cheek|jaw|gum|neck|eye)s?\s+(is\s+|are\s+|has\s+)?(swollen|swelling)/i,
      /\bswell(ing|ed)?\b/i,
      /\b(sujan|soojan|sujaan|soojh|sooj|suj)\b/i,
      /(सूजन|सूज)/,
    ],
  },
  {
    trigger: "uncontrolled_bleeding",
    level: "urgent",
    patterns: [
      /\bbleed(ing)?\s+(won'?t|will not|doesn'?t|does not|not)\s+stop/i,
      /\b(heavy|lot of|lots of|non-?stop|continuous)\s+bleeding\b/i,
      /\bbleeding\s+(a lot|heavily|since)\b/i,
      /\b(khoon|khun|blood)\s+(nahi|nhi)\s+(ruk|band)/i,
      // "khoon ruk nahi raha", "khoon band hi nahi ho raha": a couple of words may sit in between.
      /\b(khoon|khun|blood)\s+(\w+\s+){0,2}(ruk|band)\s+(\w+\s+){0,2}(nahi|nhi|na)\b/i,
      /\b(khoon|khun|blood)\s+(\w+\s+){0,2}(nahi|nhi)\s+(\w+\s+){0,1}(ruk|band)/i,
      /\bblood\s+(is\s+)?(not stopping|won'?t stop|keeps coming)/i,
      /\b(bahut|lagatar|zyada|jyada)\s+(khoon|khun)\b/i,
      /\b(khoon|khun)\s+(bahut|lagatar|zyada|jyada|beh)/i,
      /खून\s*(नहीं\s*रुक|बंद नहीं|बहुत|लगातार)|(बहुत|लगातार)\s*खून/,
    ],
  },
  {
    trigger: "trauma",
    level: "urgent",
    patterns: [
      /\b(accident|fell|fall|hit|injur(y|ed)|trauma)\b/i,
      /\b(broke|broken|cracked|knocked out|chipped)\b.*\btooth|\btooth\b.*\b(broke|broken|knocked out|fell out)/i,
      /\b(chot|chhot|accident|gir\s+gay[ae]|gir\s+gai)\b/i,
      /\bdaa?nt\s+(toot|tut|tooṭ|nikal\s+gaya|gir\s+gaya)/i,
      /(चोट|दुर्घटना|एक्सीडेंट|दाँत टूट|दांत टूट|गिर गया|गिर गई)/,
    ],
  },
  {
    trigger: "fever_with_pain",
    level: "urgent",
    patterns: [/\b(high\s+)?fever\b/i, /\b(tez\s+)?(bukhar|bukhaar)\b/i, /(बुखार)/],
  },
  {
    trigger: "severe_pain",
    level: "urgent",
    patterns: [
      /\b(severe|unbearable|extreme|terrible|excruciating)\s+pain\b/i,
      /\bpain\s+(is\s+)?(unbearable|not stopping|won'?t stop|killing)/i,
      /\bbahut\s+(tez\s+|zyada\s+|jyada\s+)?dard\b/i,
      /\bdard\s+(bardasht|sahan)\s+nahi\b/i,
      /\b(bardasht|bardaasht|sahan|sehen|sehan)\s+(\w+\s+){0,1}(nahi|nhi|na)\b/i,
      /\b(can'?t|cannot|unable to)\s+(bear|tolerate|stand)\s+(the\s+)?pain/i,
      /\b(asahniya|asahneey)\b/i,
      /(बहुत\s*(तेज़|तेज|ज़्यादा)?\s*दर्द|असहनीय|बर्दाश्त नहीं)/,
    ],
  },
  {
    trigger: "post_surgery_problem",
    level: "urgent",
    patterns: [
      /\b(after|since)\s+(the\s+)?(surgery|extraction|implant|operation)\b/i,
      /\b(surgery|extraction|operation|implant)\s+(ke\s+)?baad\b/i,
      /(सर्जरी|ऑपरेशन|दाँत निकलवाने)\s*के\s*बाद/,
    ],
  },
];

export function detectEmergency(text: string, extraTriggers: string[] = []): EmergencyResult {
  const matched = new Map<string, Rule["level"]>();
  // Hindi-script text is also checked in Roman letters, so every Hinglish rule applies to it too.
  const variants = hasDevanagari(text) ? [text, romanize(text)] : [text];
  for (const rule of RULES)
    if (rule.patterns.some((p) => variants.some((v) => p.test(v)))) matched.set(rule.trigger, rule.level);
  const lower = variants.join(" ").toLowerCase();
  for (const phrase of extraTriggers)
    if (phrase.trim() && lower.includes(phrase.trim().toLowerCase()))
      matched.set(`clinic:${phrase}`, "urgent");
  const levels = [...matched.values()];
  const level: EmergencyLevel = levels.includes("life_threatening")
    ? "life_threatening"
    : levels.length
      ? "urgent"
      : "none";
  return { level, triggers: [...matched.keys()] };
}

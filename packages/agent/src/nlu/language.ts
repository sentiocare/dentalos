import type { Lang } from "@dentalos/core";

const HINGLISH_MARKERS = new Set(
  "hai hain kya ka ki ke ko se mein me mujhe mera meri mere aap aapka apna chahiye nahi nahin haan han ji kal parso aaj kab kitna kitne kaise kahan kaha karna karwana karwani hoga raha rahi tha thi bhi toh abhi baje subah shaam dopahar raat daant dard wala wali liye kar karo karein batao bataiye dikhana milna theek thik accha acha".split(
    " ",
  ),
);

/** Devanagari → Hindi; Roman script with Hindi words → Hinglish; otherwise English. */
export function detectLanguage(text: string): Lang | null {
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return null;
  const hindi = words.filter((w) => HINGLISH_MARKERS.has(w)).length;
  return hindi >= 1 && hindi / words.length >= 0.15 ? "hinglish" : "en";
}

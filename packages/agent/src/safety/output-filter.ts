/**
 * Last check on every sentence the assistant sends (Build Prompt §6.5, §7.8). The assistant's replies are
 * written by code, but they include clinic-entered text and, later, voice-model output; this filter is the
 * code-level guarantee that no medicine, dosage, diagnosis, severity judgement or promise goes out.
 */

// Common Indian brand and generic names for painkillers, antibiotics, antacids, local anaesthetics and gels.
const MEDICINES = [
  "paracetamol",
  "crocin",
  "dolo",
  "calpol",
  "ibuprofen",
  "brufen",
  "combiflam",
  "diclofenac",
  "voveran",
  "aceclofenac",
  "zerodol",
  "hifenac",
  "ketorolac",
  "ketorol",
  "nimesulide",
  "nise",
  "mefenamic",
  "meftal",
  "tramadol",
  "ultracet",
  "aspirin",
  "disprin",
  "amoxicillin",
  "amoxycillin",
  "novamox",
  "mox",
  "augmentin",
  "clavam",
  "moxikind",
  "azithromycin",
  "azithral",
  "azee",
  "metronidazole",
  "flagyl",
  "metrogyl",
  "ornidazole",
  "clindamycin",
  "cefixime",
  "taxim",
  "ciprofloxacin",
  "ciplox",
  "doxycycline",
  "ofloxacin",
  "pantoprazole",
  "pantocid",
  "pan 40",
  "pan-d",
  "omeprazole",
  "rabeprazole",
  "ranitidine",
  "chlorhexidine",
  "hexidine",
  "lignocaine",
  "lidocaine",
  "orajel",
  "dentogel",
  "mucopain",
  "zytee",
  "antibiotic",
  "painkiller",
  "pain killer",
  "एंटीबायोटिक",
  "पेनकिलर",
  "दर्द की गोली",
];

// Home remedies are medical advice too.
const REMEDIES = [
  "clove oil",
  "laung",
  "लौंग",
  "salt water",
  "namak pani",
  "namak ka pani",
  "नमक",
  "haldi",
  "हल्दी",
  "garam pani se kulla",
  "warm saline",
  "hydrogen peroxide",
];

const DOSAGE = [
  /\b\d+(\.\d+)?\s?(mg|mcg|ml|gm|g)\b/i,
  /\b(tablet|tablets|capsule|capsules|goli|golis|syrup|dose)\b/i,
  /\b(twice|thrice|once)\s+(a|per)\s+day\b/i,
  /\b(din\s+m(e|ei|ein)\s+(ek|do|teen)\s+baar)\b/i,
  /\b[0-2]-[0-2]-[0-2]\b/,
  /(गोली|दवा|दवाई|खुराक)/,
  /\b(dawa|dawai|dawaai|medicine le|medicine lo)\b/i,
];

const SEVERITY = [
  /\b(not|nothing)\s+(serious|to worry)\b/i,
  /\bdon'?t\s+worry\b/i,
  /\b(it'?s|this is)\s+(normal|nothing|fine|minor)\b/i,
  /\b(serious|gambhir)\s+nahi\b/i,
  /\b(chinta|ghabrane)\s+(ki|ka)\s+(koi\s+)?(baat|zarurat|jarurat)\s+nahi\b/i,
  /\bnormal\s+hai\b/i,
  /(गंभीर नहीं|चिंता की (कोई )?बात नहीं|घबराने की (कोई )?(बात|ज़रूरत) नहीं|सामान्य है)/,
];

const DIAGNOSIS = [
  /\byou\s+(have|might have|probably have)\s+(a|an)?\s*(cavity|infection|abscess|gum disease)\b/i,
  /\b(it|this)\s+(is|looks like)\s+(a|an)?\s*(cavity|infection|abscess)\b/i,
  /\baapko\s+(infection|cavity|keeda)\s+hai\b/i,
  /(आपको (इन्फेक्शन|कैविटी|संक्रमण) है)/,
];

const PROMISES = [
  /\bpain(less|-free| free)\b/i,
  /\bguarantee(d)?\b/i,
  /\b100\s?%/,
  /\bbest\s+(dentist|clinic|doctor|treatment|in (the )?city)\b/i,
  /\bcheapest\b/i,
  /\b(dard|pain)\s+nahi\s+hoga\b/i,
  /(दर्द नहीं होगा|गारंटी)/,
];

export type SafetyReason = "medicine" | "remedy" | "dosage" | "severity" | "diagnosis" | "promise";

function hasWord(text: string, word: string): boolean {
  if (/[ऀ-ॿ]/.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}([^a-z]|$)`, "i").test(text);
}

export function checkOutput(text: string): { ok: true } | { ok: false; reasons: SafetyReason[] } {
  const reasons = new Set<SafetyReason>();
  if (MEDICINES.some((m) => hasWord(text, m))) reasons.add("medicine");
  if (REMEDIES.some((m) => hasWord(text, m))) reasons.add("remedy");
  if (DOSAGE.some((r) => r.test(text))) reasons.add("dosage");
  if (SEVERITY.some((r) => r.test(text))) reasons.add("severity");
  if (DIAGNOSIS.some((r) => r.test(text))) reasons.add("diagnosis");
  if (PROMISES.some((r) => r.test(text))) reasons.add("promise");
  return reasons.size ? { ok: false, reasons: [...reasons] } : { ok: true };
}

/**
 * Devanagari → Hinglish (Roman) so the same understanding rules work on Hindi speech transcripts and
 * Hindi-script WhatsApp messages. ("मुझे कल शाम को अपॉइंटमेंट चाहिए" → "mujhe kal shaam ko appointment
 * chahiye".) Common words come from a dictionary; everything else is transliterated letter by letter with
 * Hindi's usual dropping of silent "a" sounds. It only needs to be good enough for pattern matching.
 */

const WORDS: Record<string, string> = {
  // English words people say in Hindi sentences.
  अपॉइंटमेंट: "appointment",
  अपोइंटमेंट: "appointment",
  अपॉइन्टमेंट: "appointment",
  डॉक्टर: "doctor",
  डाक्टर: "doctor",
  डेंटिस्ट: "dentist",
  क्लिनिक: "clinic",
  टाइम: "time",
  बुकिंग: "booking",
  बुक: "book",
  कैंसल: "cancel",
  कैन्सल: "cancel",
  कन्फर्म: "confirm",
  रीशेड्यूल: "reschedule",
  ओके: "ok",
  प्लीज: "please",
  प्लीज़: "please",
  सॉरी: "sorry",
  थैंक: "thank",
  थैंक्स: "thanks",
  यू: "you",
  इंग्लिश: "english",
  हिंदी: "hindi",
  नंबर: "number",
  एड्रेस: "address",
  लोकेशन: "location",
  फीस: "fees",
  प्राइस: "price",
  चार्ज: "charge",
  चार्जेस: "charges",
  चेकअप: "checkup",
  एक्सरे: "xray",
  इमरजेंसी: "emergency",
  पेन: "pain",
  क्लीनिंग: "cleaning",
  सफ़ाई: "safai",
  सफाई: "safai",
  साफ़: "saaf",
  साफ: "saaf",
  जाँच: "jaanch",
  जांच: "jaanch",
  दिखाना: "dikhana",
  निकलवाना: "nikalwana",
  लगवाना: "lagwana",
  करवाना: "karwana",
  कराना: "karana",
  फिलिंग: "filling",
  ब्रेसेस: "braces",
  इम्प्लांट: "implant",
  इंप्लांट: "implant",
  क्राउन: "crown",
  कैप: "cap",
  रूट: "root",
  कैनाल: "canal",
  आरसीटी: "rct",
  स्केलिंग: "scaling",
  मैडम: "madam",
  सर: "sir",
  स्टाफ: "staff",
  रिसेप्शन: "reception",
  रोबोट: "robot",
  मशीन: "machine",
  बॉट: "bot",
  संडे: "sunday",
  मंडे: "monday",
  नेक्स्ट: "next",
  वीक: "week",
  मॉर्निंग: "morning",
  इवनिंग: "evening",
  // Common Hindi words whose spelling in Roman is fixed by habit.
  हाँ: "haan",
  हां: "haan",
  जी: "ji",
  नहीं: "nahi",
  नही: "nahi",
  ठीक: "theek",
  है: "hai",
  हैं: "hain",
  मैं: "main",
  में: "mein",
  मुझे: "mujhe",
  मेरा: "mera",
  मेरी: "meri",
  मेरे: "mere",
  आप: "aap",
  कल: "kal",
  आज: "aaj",
  परसों: "parson",
  सुबह: "subah",
  दोपहर: "dopahar",
  शाम: "shaam",
  रात: "raat",
  बजे: "baje",
  साढ़े: "saadhe",
  सवा: "sawa",
  पौने: "paune",
  डेढ़: "dedh",
  ढाई: "dhaai",
  दाँत: "daant",
  दांत: "daant",
  दर्द: "dard",
  सूजन: "sujan",
  खून: "khoon",
  साँस: "saans",
  सांस: "saans",
  चाहिए: "chahiye",
  कितना: "kitna",
  कितने: "kitne",
  कहाँ: "kahan",
  कहां: "kahan",
  पहला: "pehla",
  पहले: "pehle",
  दूसरा: "doosra",
  दूसरे: "doosre",
  तीसरा: "teesra",
  वाला: "wala",
  वाले: "wale",
  बात: "baat",
  करनी: "karni",
  करना: "karna",
  बदलना: "badalna",
  रद्द: "radd",
  एक: "1",
  दो: "2",
  तीन: "3",
  चार: "4",
  पांच: "5",
  पाँच: "5",
  छह: "6",
  छः: "6",
  सात: "7",
  आठ: "8",
  नौ: "9",
  दस: "10",
  ग्यारह: "11",
  बारह: "12",
};

const VOWELS: Record<string, string> = {
  अ: "a",
  आ: "aa",
  इ: "i",
  ई: "ee",
  उ: "u",
  ऊ: "oo",
  ऋ: "ri",
  ए: "e",
  ऐ: "ai",
  ओ: "o",
  औ: "au",
  ऑ: "o",
};
const MATRAS: Record<string, string> = {
  "ा": "aa",
  "ि": "i",
  "ी": "ee",
  "ु": "u",
  "ू": "oo",
  "ृ": "ri",
  "े": "e",
  "ै": "ai",
  "ो": "o",
  "ौ": "au",
  "ॉ": "o",
};
const CONSONANTS: Record<string, string> = {
  क: "k",
  ख: "kh",
  ग: "g",
  घ: "gh",
  ङ: "n",
  च: "ch",
  छ: "chh",
  ज: "j",
  झ: "jh",
  ञ: "n",
  ट: "t",
  ठ: "th",
  ड: "d",
  ढ: "dh",
  ण: "n",
  त: "t",
  थ: "th",
  द: "d",
  ध: "dh",
  न: "n",
  प: "p",
  फ: "ph",
  ब: "b",
  भ: "bh",
  म: "m",
  य: "y",
  र: "r",
  ल: "l",
  व: "v",
  श: "sh",
  ष: "sh",
  स: "s",
  ह: "h",
};
const NUKTA: Record<string, string> = { क: "q", ख: "kh", ग: "g", ज: "z", ड: "r", ढ: "rh", फ: "f" };
const DIGITS = "०१२३४५६७८९";
const VIRAMA = "्";
const NUKTA_SIGN = "़";

interface Syllable {
  consonant: string | null;
  vowel: string | null; // null = inherent "a"
  nasal: boolean;
  halant: boolean;
}

function transliterateWord(word: string): string {
  const chars = [...word];
  const syllables: Syllable[] = [];
  let out = "";
  const flush = () => {
    // Inherent "a" is silent at the end of a word, and between a vowel and a consonant that has its own
    // vowel ("sak-ta", "kar-na", "man-gal-vaar"), the usual Hindi pronunciation.
    syllables.forEach((s, i) => {
      if (s.consonant === null) {
        out += (s.vowel ?? "") + (s.nasal ? "n" : "");
        return;
      }
      let vowel = s.vowel;
      // A long "aa" ending a longer word is written "a" in Hinglish: "sakta", "kitna", "wala".
      if (vowel === "aa" && i === syllables.length - 1 && syllables.length >= 2 && !s.nasal) vowel = "a";
      if (vowel === null && !s.halant) {
        const last = i === syllables.length - 1;
        const next = syllables[i + 1];
        const prevHasVowel = i > 0 && !syllables[i - 1]!.halant;
        const silent = last || (prevHasVowel && !!next && next.consonant !== null && next.vowel !== null);
        vowel = silent && !s.nasal ? "" : "a";
      }
      out += s.consonant + (s.halant ? "" : (vowel ?? "")) + (s.nasal ? "n" : "");
    });
    syllables.length = 0;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (CONSONANTS[ch]) {
      const nukta = chars[i + 1] === NUKTA_SIGN;
      syllables.push({
        consonant: nukta ? (NUKTA[ch] ?? CONSONANTS[ch]!) : CONSONANTS[ch]!,
        vowel: null,
        nasal: false,
        halant: false,
      });
      if (nukta) i++;
    } else if (MATRAS[ch] && syllables.length) {
      syllables[syllables.length - 1]!.vowel = MATRAS[ch]!;
    } else if (ch === VIRAMA && syllables.length) {
      syllables[syllables.length - 1]!.halant = true;
    } else if ((ch === "ं" || ch === "ँ") && syllables.length) {
      const s = syllables[syllables.length - 1]!;
      if (s.consonant !== null && s.vowel === null) s.vowel = "a";
      s.nasal = true;
    } else if (ch === "ः") {
      if (syllables.length) syllables[syllables.length - 1]!.vowel ??= "a";
      syllables.push({ consonant: null, vowel: "h", nasal: false, halant: false });
    } else if (VOWELS[ch]) {
      syllables.push({ consonant: null, vowel: VOWELS[ch]!, nasal: false, halant: false });
    } else if (DIGITS.includes(ch)) {
      flush();
      out += String(DIGITS.indexOf(ch));
    } else if (ch === NUKTA_SIGN) {
      // stray nukta: ignore
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

export const hasDevanagari = (text: string) => /[ऀ-ॿ]/.test(text);

export function romanize(text: string): string {
  if (!hasDevanagari(text)) return text;
  return text
    .split(/(\s+|[,.!?।॥;:"'()-]+)/)
    .map((token) => {
      if (!hasDevanagari(token)) return token === "।" || token === "॥" ? "." : token;
      const clean = token.replace(/[।॥]/g, "");
      return WORDS[clean] ?? transliterateWord(clean);
    })
    .join("")
    .replace(/[।॥]/g, ".");
}

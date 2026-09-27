/**
 * Starting procedure list for a new clinic. Durations follow Dr. Sharma's brief (consultation 15, scaling
 * 30, RCT sitting 45, implant surgery 90). Prices are deliberately empty and not public: the assistant may
 * only quote prices the clinic has entered and approved (Build Prompt §6.4).
 */
export interface DefaultProcedure {
  code: string;
  name: string;
  nameHi: string;
  category: string;
  durationMin: number;
  bufferMin: number;
  synonyms: string[];
  isConsultation?: boolean;
  requiresLab?: boolean;
  /** Filled only by the visiting specialist of this kind, once one is added. */
  specialist?: "orthodontist" | "endodontist" | "oral_surgeon";
  /** Months until a recall reminder (Build Prompt §5.4). */
  recallMonths?: number;
  /** Next-day "how are you feeling?" check-in. */
  checkin?: boolean;
  /**
   * Standard after-care wording. Sent only once a doctor has reviewed it in settings (approved: false here),
   * because it is clinical advice.
   */
  aftercare?: { en: string; hi: string };
}

const EXTRACTION_CARE = {
  en: "Bite on the cotton for 30–45 minutes. Today, do not spit, rinse hard or use a straw, and avoid smoking. Eat soft, cool food. Call the clinic if bleeding does not stop or swelling increases.",
  hi: "रुई को 30–45 मिनट दबाकर रखें। आज थूकें नहीं, ज़ोर से कुल्ला न करें, स्ट्रॉ का इस्तेमाल न करें और धूम्रपान न करें। नरम, ठंडा खाना खाएँ। खून न रुके या सूजन बढ़े तो क्लिनिक को फ़ोन करें।",
};

export const DEFAULT_PROCEDURES: DefaultProcedure[] = [
  {
    code: "consultation",
    name: "Consultation",
    nameHi: "परामर्श",
    category: "general",
    durationMin: 15,
    bufferMin: 0,
    isConsultation: true,
    synonyms: ["checkup", "check up", "consult", "dikhana hai", "doctor se milna", "jaanch"],
    recallMonths: 6,
  },
  {
    code: "emergency_visit",
    name: "Emergency visit",
    nameHi: "इमरजेंसी",
    category: "general",
    durationMin: 20,
    bufferMin: 5,
    synonyms: ["dard", "pain", "emergency", "sujan", "swelling"],
  },
  {
    code: "xray_iopa",
    name: "X-ray (IOPA)",
    nameHi: "एक्स-रे",
    category: "diagnostic",
    durationMin: 10,
    bufferMin: 0,
    synonyms: ["xray", "x ray", "iopa"],
  },
  {
    code: "opg",
    name: "OPG (full mouth X-ray)",
    nameHi: "ओपीजी",
    category: "diagnostic",
    durationMin: 15,
    bufferMin: 0,
    synonyms: ["opg", "full xray"],
  },
  {
    code: "scaling",
    name: "Scaling and polishing",
    nameHi: "सफ़ाई (स्केलिंग)",
    category: "preventive",
    durationMin: 30,
    bufferMin: 5,
    synonyms: ["cleaning", "safai", "daant saaf", "scaling", "polishing"],
    recallMonths: 6,
  },
  {
    code: "filling",
    name: "Filling",
    nameHi: "फ़िलिंग",
    category: "restorative",
    durationMin: 30,
    bufferMin: 5,
    synonyms: ["filling", "cavity", "keeda", "masala bharna"],
  },
  {
    code: "rct_sitting",
    name: "Root canal (RCT) sitting",
    nameHi: "रूट कैनाल (RCT)",
    category: "endodontics",
    durationMin: 45,
    bufferMin: 10,
    synonyms: ["rct", "root canal", "nas ka ilaaj", "nerve treatment"],
  },
  {
    code: "extraction",
    name: "Extraction",
    nameHi: "दाँत निकालना",
    category: "surgery",
    durationMin: 30,
    bufferMin: 10,
    synonyms: ["extraction", "daant nikalna", "daant nikalwana", "ukhadna"],
    checkin: true,
    aftercare: EXTRACTION_CARE,
  },
  {
    code: "surgical_extraction",
    name: "Surgical / wisdom tooth extraction",
    nameHi: "अक्ल दाढ़ निकालना",
    category: "surgery",
    durationMin: 60,
    bufferMin: 15,
    synonyms: ["wisdom tooth", "akal daadh", "akkal daadh", "impaction"],
    checkin: true,
    aftercare: EXTRACTION_CARE,
    specialist: "oral_surgeon",
  },
  {
    code: "crown_prep",
    name: "Crown preparation and impression",
    nameHi: "कैप का माप",
    category: "prosthodontics",
    durationMin: 45,
    bufferMin: 10,
    synonyms: ["crown", "cap", "cap lagwana", "impression"],
  },
  {
    code: "crown_fitting",
    name: "Crown / bridge fitting",
    nameHi: "कैप लगाना",
    category: "prosthodontics",
    durationMin: 30,
    bufferMin: 5,
    requiresLab: true,
    synonyms: ["crown fitting", "cap fitting", "bridge"],
  },
  {
    code: "implant_surgery",
    name: "Implant surgery",
    nameHi: "इम्प्लांट सर्जरी",
    category: "implants",
    durationMin: 90,
    bufferMin: 15,
    synonyms: ["implant", "naya daant", "fixed daant"],
    checkin: true,
  },
  {
    code: "implant_followup",
    name: "Implant follow-up / healing check",
    nameHi: "इम्प्लांट जाँच",
    category: "implants",
    durationMin: 20,
    bufferMin: 5,
    synonyms: ["implant check"],
  },
  {
    code: "ortho_consultation",
    name: "Braces / aligner consultation",
    nameHi: "ब्रेसेस परामर्श",
    category: "orthodontics",
    durationMin: 20,
    bufferMin: 0,
    isConsultation: true,
    synonyms: ["braces", "taar", "aligner", "teedhe daant"],
    specialist: "orthodontist",
  },
  {
    code: "ortho_adjustment",
    name: "Braces adjustment",
    nameHi: "ब्रेसेस टाइट करना",
    category: "orthodontics",
    durationMin: 20,
    bufferMin: 0,
    synonyms: ["braces tight", "wire change", "monthly adjustment"],
    specialist: "orthodontist",
  },
  {
    code: "denture_impression",
    name: "Denture impression",
    nameHi: "डेन्चर माप",
    category: "prosthodontics",
    durationMin: 30,
    bufferMin: 5,
    synonyms: ["denture", "batteesi", "nakli daant"],
  },
  {
    code: "denture_trial",
    name: "Denture trial",
    nameHi: "डेन्चर ट्रायल",
    category: "prosthodontics",
    durationMin: 30,
    bufferMin: 5,
    requiresLab: true,
    synonyms: ["denture trial"],
  },
  {
    code: "denture_delivery",
    name: "Denture delivery",
    nameHi: "डेन्चर देना",
    category: "prosthodontics",
    durationMin: 30,
    bufferMin: 5,
    requiresLab: true,
    synonyms: ["denture delivery"],
  },
  {
    code: "pediatric",
    name: "Child dental treatment",
    nameHi: "बच्चों का इलाज",
    category: "pediatric",
    durationMin: 30,
    bufferMin: 10,
    synonyms: ["baccha", "child", "kids"],
  },
  {
    code: "whitening",
    name: "Teeth whitening",
    nameHi: "दाँत सफ़ेद करना",
    category: "cosmetic",
    durationMin: 60,
    bufferMin: 10,
    synonyms: ["whitening", "bleaching", "safed daant"],
  },
  {
    code: "followup",
    name: "Follow-up / review",
    nameHi: "फ़ॉलो-अप",
    category: "general",
    durationMin: 15,
    bufferMin: 0,
    synonyms: ["follow up", "review", "dobara dikhana"],
  },
];

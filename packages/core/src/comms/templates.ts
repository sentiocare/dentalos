import type { PoolClient } from "pg";
/**
 * Standard messages, in English and Hindi. Each is registered with Meta as a template (needed outside the
 * 24-hour window) and the same text is sent as a normal message when the patient wrote to us recently.
 * Placeholders are {{1}}, {{2}}… as in WhatsApp templates. Safe, factual wording (Build Prompt §7.7): no
 * superlatives, no urgency, no medical claims.
 */
export type TemplatePurpose =
  | "booking_confirmation"
  | "reminder_day_before"
  | "reminder_same_day"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "missed_call"
  | "staff_alert"
  | "estimate_ready"
  | "estimate_followup"
  | "treatment_next_sitting"
  | "no_show"
  | "recall"
  | "aftercare"
  | "checkin"
  | "reactivation"
  | "deposit_request"
  | "payment_receipt"
  | "dues_reminder"
  | "billing_wallet_low"
  | "billing_wallet_paused"
  | "billing_predebit"
  | "billing_recharge_failed"
  | "billing_spend_alert"
  | "billing_link"
  | "lead_welcome"
  | "lead_nudge"
  | "lead_checkin"
  | "review_request"
  | "owner_daily_report"
  | "prescription";

export interface TemplateDefinition {
  purpose: TemplatePurpose;
  name: string;
  category: "utility" | "marketing";
  /** What each placeholder holds, for staff and for Meta's review. */
  params: string[];
  body: { en: string; hi: string };
  /** Quick-reply buttons (titles ≤ 20 characters); payloads are filled per message. */
  buttons?: { en: string; hi: string }[];
}

export const TEMPLATES: Record<TemplatePurpose, TemplateDefinition> = {
  booking_confirmation: {
    purpose: "booking_confirmation",
    name: "sentio_booking_confirmation",
    category: "utility",
    params: ["patient name", "clinic name", "day and time", "doctor"],
    body: {
      en: "Namaste {{1}}, your appointment at {{2}} is booked for {{3}} with {{4}}. Reply here if you need to change it.",
      hi: "नमस्ते {{1}}, {{2}} में आपका अपॉइंटमेंट {{3}} को {{4}} के साथ बुक हो गया है। बदलना हो तो यहीं जवाब दें।",
    },
  },
  reminder_day_before: {
    purpose: "reminder_day_before",
    name: "sentio_reminder_day_before",
    category: "utility",
    params: ["patient name", "clinic name", "day and time", "doctor"],
    body: {
      en: "Reminder: {{1}}, your appointment at {{2}} is tomorrow, {{3}}, with {{4}}. Please confirm or reschedule.",
      hi: "याद दिलाना: {{1}}, {{2}} में आपका अपॉइंटमेंट कल, {{3}} को {{4}} के साथ है। कृपया पक्का करें या समय बदलें।",
    },
    buttons: [
      { en: "Confirm", hi: "पक्का करें" },
      { en: "Reschedule", hi: "समय बदलें" },
    ],
  },
  reminder_same_day: {
    purpose: "reminder_same_day",
    name: "sentio_reminder_same_day",
    category: "utility",
    params: ["patient name", "clinic name", "time", "directions link"],
    body: {
      en: "{{1}}, see you today at {{3}} at {{2}}. Directions: {{4}}",
      hi: "{{1}}, आज {{3}} पर {{2}} में आपका इंतज़ार रहेगा। रास्ता: {{4}}",
    },
  },
  appointment_cancelled: {
    purpose: "appointment_cancelled",
    name: "sentio_appointment_cancelled",
    category: "utility",
    params: ["patient name", "clinic name", "day and time"],
    body: {
      en: "{{1}}, your appointment at {{2}} on {{3}} is cancelled. Reply here any time to book a new one.",
      hi: "{{1}}, {{2}} में {{3}} का आपका अपॉइंटमेंट रद्द हो गया है। नया अपॉइंटमेंट लेने के लिए कभी भी यहाँ जवाब दें।",
    },
  },
  appointment_rescheduled: {
    purpose: "appointment_rescheduled",
    name: "sentio_appointment_rescheduled",
    category: "utility",
    params: ["patient name", "clinic name", "new day and time", "doctor"],
    body: {
      en: "{{1}}, your appointment at {{2}} is now on {{3}} with {{4}}.",
      hi: "{{1}}, {{2}} में आपका अपॉइंटमेंट अब {{3}} को {{4}} के साथ है।",
    },
  },
  missed_call: {
    purpose: "missed_call",
    name: "sentio_missed_call",
    category: "utility",
    params: ["clinic name"],
    body: {
      en: "Namaste, this is {{1}}. Sorry we missed your call. Reply here to book an appointment or ask a question.",
      hi: "नमस्ते, यह {{1}} है। माफ़ कीजिए, हम आपकी कॉल नहीं उठा सके। अपॉइंटमेंट या कोई सवाल हो तो यहीं जवाब दें।",
    },
  },
  staff_alert: {
    purpose: "staff_alert",
    name: "sentio_staff_alert",
    category: "utility",
    params: ["alert type", "patient name and number", "summary"],
    body: {
      en: "Sentio alert ({{1}}): {{2}}. {{3}} Please call back as soon as possible.",
      hi: "Sentio अलर्ट ({{1}}): {{2}}। {{3}} कृपया जल्द से जल्द कॉल करें।",
    },
  },
  estimate_ready: {
    purpose: "estimate_ready",
    name: "sentio_estimate_ready",
    category: "utility",
    params: ["patient name", "clinic name", "total", "link to the estimate"],
    body: {
      en: "Namaste {{1}}, your treatment estimate from {{2}} is ready: total {{3}}. You can see it here: {{4}}. Reply with any question.",
      hi: "नमस्ते {{1}}, {{2}} से आपके इलाज का अनुमान (estimate) तैयार है: कुल {{3}}। यहाँ देखें: {{4}}। कोई सवाल हो तो जवाब दें।",
    },
    buttons: [
      { en: "Go ahead", hi: "आगे बढ़ें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  estimate_followup: {
    purpose: "estimate_followup",
    name: "sentio_estimate_followup",
    category: "utility",
    params: ["patient name", "clinic name", "total"],
    body: {
      en: "{{1}}, this is {{2}}. Do you have any questions about your treatment estimate ({{3}})? We can book your first sitting whenever you are ready.",
      hi: "{{1}}, यह {{2}} है। क्या आपके इलाज के अनुमान ({{3}}) के बारे में कोई सवाल है? जब आप तैयार हों, हम पहली सिटिंग बुक कर सकते हैं।",
    },
    buttons: [
      { en: "Book sitting", hi: "सिटिंग बुक करें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  treatment_next_sitting: {
    purpose: "treatment_next_sitting",
    name: "sentio_treatment_next_sitting",
    category: "utility",
    params: ["patient name", "clinic name", "treatment", "when it is due"],
    body: {
      en: "{{1}}, your next sitting for {{3}} at {{2}} is due {{4}}. It is best to keep to the planned schedule. Shall we book it?",
      hi: "{{1}}, {{2}} में {{3}} की आपकी अगली सिटिंग {{4}} होनी है। तय समय पर इलाज पूरा करना अच्छा रहता है। क्या बुक करें?",
    },
    buttons: [
      { en: "Book now", hi: "अभी बुक करें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  no_show: {
    purpose: "no_show",
    name: "sentio_no_show",
    category: "utility",
    params: ["patient name", "clinic name", "day"],
    body: {
      en: "{{1}}, we missed you at {{2}} on {{3}}. Would you like to book a new time?",
      hi: "{{1}}, {{3}} को {{2}} में आपका इंतज़ार था। क्या नया समय बुक करें?",
    },
    buttons: [
      { en: "Book again", hi: "फिर से बुक करें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  recall: {
    purpose: "recall",
    name: "sentio_recall",
    category: "utility",
    params: ["patient name", "clinic name", "months since the last visit"],
    body: {
      en: "Namaste {{1}}, it has been {{3}} months since your last visit to {{2}}. It is time for your regular dental check-up. Shall we book it?",
      hi: "नमस्ते {{1}}, {{2}} में आपकी पिछली विज़िट को {{3}} महीने हो गए हैं। नियमित दाँतों की जाँच का समय हो गया है। क्या बुक करें?",
    },
    buttons: [{ en: "Book check-up", hi: "जाँच बुक करें" }],
  },
  aftercare: {
    purpose: "aftercare",
    name: "sentio_aftercare",
    category: "utility",
    params: ["patient name", "clinic name", "treatment", "the doctor's after-care instructions"],
    body: {
      en: "{{1}}, after-care for your {{3}} at {{2}}: {{4}}",
      hi: "{{1}}, {{2}} में आपके {{3}} के बाद ध्यान रखें: {{4}}",
    },
  },
  checkin: {
    purpose: "checkin",
    name: "sentio_checkin",
    category: "utility",
    params: ["patient name", "clinic name", "treatment"],
    body: {
      en: "Namaste {{1}}, this is {{2}}. How are you feeling after your {{3}} yesterday?",
      hi: "नमस्ते {{1}}, यह {{2}} है। कल के {{3}} के बाद आप कैसा महसूस कर रहे हैं?",
    },
    buttons: [
      { en: "Feeling fine", hi: "ठीक हूँ" },
      { en: "Some pain", hi: "थोड़ा दर्द है" },
      { en: "Need help", hi: "मदद चाहिए" },
    ],
  },
  reactivation: {
    purpose: "reactivation",
    name: "sentio_reactivation",
    category: "marketing",
    params: ["patient name", "clinic name", "the clinic's message"],
    body: {
      en: "Namaste {{1}}, it has been a while since your last visit to {{2}}. {{3}} Reply to book a check-up, or STOP to stop these messages.",
      hi: "नमस्ते {{1}}, {{2}} में आपकी पिछली विज़िट को काफ़ी समय हो गया है। {{3}} जाँच बुक करने के लिए जवाब दें, या ये मैसेज बंद करने के लिए STOP लिखें।",
    },
    buttons: [{ en: "Book check-up", hi: "जाँच बुक करें" }],
  },
  deposit_request: {
    purpose: "deposit_request",
    name: "sentio_deposit_request",
    category: "utility",
    params: ["patient name", "clinic name", "amount", "payment link"],
    body: {
      en: "{{1}}, to confirm your appointment at {{2}}, please pay the advance of {{3}} here: {{4}}",
      hi: "{{1}}, {{2}} में अपना अपॉइंटमेंट पक्का करने के लिए {{3}} का एडवांस यहाँ दें: {{4}}",
    },
  },
  payment_receipt: {
    purpose: "payment_receipt",
    name: "sentio_payment_receipt",
    category: "utility",
    params: ["patient name", "amount", "clinic name", "receipt link"],
    body: {
      en: "{{1}}, we have received {{2}}. Thank you. Your receipt from {{3}}: {{4}}",
      hi: "{{1}}, हमें {{2}} मिल गए हैं। धन्यवाद। {{3}} की आपकी रसीद: {{4}}",
    },
  },
  dues_reminder: {
    purpose: "dues_reminder",
    name: "sentio_dues_reminder",
    category: "utility",
    params: ["patient name", "clinic name", "amount due", "payment link"],
    body: {
      en: "Namaste {{1}}, the balance on your account at {{2}} is {{3}}. You can pay online here: {{4}} If you have already paid, please ignore this message.",
      hi: "नमस्ते {{1}}, {{2}} में आपके खाते में {{3}} बाकी है। आप यहाँ ऑनलाइन भुगतान कर सकते हैं: {{4}} अगर आप भुगतान कर चुके हैं, तो इस मैसेज को अनदेखा करें।",
    },
    buttons: [{ en: "Call me", hi: "मुझे कॉल करें" }],
  },
  // To the clinic owner, about the Sentio usage wallet (Build Prompt §4.3). Never gated by the wallet.
  billing_wallet_low: {
    purpose: "billing_wallet_low",
    name: "sentio_wallet_low",
    category: "utility",
    params: ["owner name", "clinic name", "balance", "top-up link"],
    body: {
      en: "{{1}}, the Sentio usage balance for {{2}} is {{3}}. To avoid any pause, add money here: {{4}}",
      hi: "{{1}}, {{2}} का Sentio उपयोग बैलेंस {{3}} है। रुकावट से बचने के लिए यहाँ पैसे जोड़ें: {{4}}",
    },
  },
  billing_wallet_paused: {
    purpose: "billing_wallet_paused",
    name: "sentio_wallet_paused",
    category: "utility",
    params: ["owner name", "clinic name", "what is paused", "top-up link"],
    body: {
      en: "{{1}}, the Sentio usage balance for {{2}} has run out. Paused: {{3}}. Emergency calls still reach your doctors. Add money here to resume: {{4}}",
      hi: "{{1}}, {{2}} का Sentio उपयोग बैलेंस खत्म हो गया है। रुका हुआ: {{3}}। इमरजेंसी कॉल अब भी आपके डॉक्टरों तक पहुँचती हैं। फिर से शुरू करने के लिए यहाँ पैसे जोड़ें: {{4}}",
    },
  },
  billing_predebit: {
    purpose: "billing_predebit",
    name: "sentio_predebit_notice",
    category: "utility",
    params: ["owner name", "clinic name", "amount", "debit date", "mandate"],
    body: {
      en: "{{1}}, advance notice: {{3}} will be debited on {{4}} via your {{5}} to recharge the Sentio usage wallet for {{2}}. To change or cancel, reply to this message.",
      hi: "{{1}}, पूर्व सूचना: {{2}} के Sentio उपयोग वॉलेट को रिचार्ज करने के लिए {{4}} को आपके {{5}} से {{3}} काटे जाएँगे। बदलने या रद्द करने के लिए इस मैसेज का जवाब दें।",
    },
  },
  billing_recharge_failed: {
    purpose: "billing_recharge_failed",
    name: "sentio_recharge_failed",
    category: "utility",
    params: ["owner name", "clinic name", "amount", "payment link"],
    body: {
      en: "{{1}}, the automatic recharge of {{3}} for {{2}} did not go through. Please pay here instead: {{4}}",
      hi: "{{1}}, {{2}} के लिए {{3}} का ऑटोमैटिक रिचार्ज नहीं हो पाया। कृपया यहाँ भुगतान करें: {{4}}",
    },
  },
  billing_spend_alert: {
    purpose: "billing_spend_alert",
    name: "sentio_spend_alert",
    category: "utility",
    params: ["owner name", "clinic name", "percent", "spent", "monthly limit"],
    body: {
      en: "{{1}}, {{2}} has used {{3}}% of this month's Sentio spending limit ({{4}} of {{5}}).",
      hi: "{{1}}, {{2}} ने इस महीने की Sentio खर्च सीमा का {{3}}% उपयोग कर लिया है ({{5}} में से {{4}})।",
    },
  },
  billing_link: {
    purpose: "billing_link",
    name: "sentio_billing_link",
    category: "utility",
    params: ["owner name", "what it is for", "link"],
    body: {
      en: "{{1}}, here is the link for {{2}}: {{3}}",
      hi: "{{1}}, {{2}} के लिए लिंक: {{3}}",
    },
  },
  // New leads from ads (Phase 6). Meta counts these as marketing; the person asked the clinic to contact them.
  lead_welcome: {
    purpose: "lead_welcome",
    name: "sentio_lead_welcome",
    category: "marketing",
    params: ["first name", "clinic name", "what they asked about"],
    body: {
      en: "Namaste {{1}}, thank you for your interest in {{3}} at {{2}}. We would be glad to help. Tap below to book a visit, ask a question, or get a call from our team. Reply STOP to stop messages.",
      hi: "नमस्ते {{1}}, {{2}} में {{3}} के लिए आपकी रुचि का धन्यवाद। हम आपकी मदद करना चाहेंगे। विज़िट बुक करने, सवाल पूछने या हमारी टीम से कॉल पाने के लिए नीचे दबाएँ। मैसेज बंद करने के लिए STOP लिखें।",
    },
    buttons: [
      { en: "Book a visit", hi: "विज़िट बुक करें" },
      { en: "Ask a question", hi: "सवाल पूछें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  lead_nudge: {
    purpose: "lead_nudge",
    name: "sentio_lead_nudge",
    category: "marketing",
    params: ["first name", "clinic name", "what they asked about"],
    body: {
      en: "{{1}}, this is {{2}} again about {{3}}. A short consultation lets the doctor tell you exactly what you need and what it will cost. Would you like to book one? Reply STOP to stop messages.",
      hi: "{{1}}, {{2}} से फिर से {{3}} के बारे में। एक छोटे परामर्श में डॉक्टर बता सकते हैं कि आपको ठीक-ठीक क्या चाहिए और खर्च कितना होगा। क्या आप परामर्श बुक करना चाहेंगे? मैसेज बंद करने के लिए STOP लिखें।",
    },
    buttons: [
      { en: "Book a visit", hi: "विज़िट बुक करें" },
      { en: "Ask a question", hi: "सवाल पूछें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  // For leads who went quiet: a week and three weeks later, one gentle check-in each. Answers the usual
  // doubts (cost, pain, time) instead of repeating the offer; many ad leads book weeks after the ad.
  lead_checkin: {
    purpose: "lead_checkin",
    name: "sentio_lead_checkin",
    category: "marketing",
    params: ["first name", "clinic name", "what they asked about"],
    body: {
      en: "Hello {{1}}, {{2}} here. Still thinking about {{3}}? Most people want to know the cost, whether it hurts and how many visits it takes. The doctor can answer all three in a short consultation, with no obligation to go ahead. Reply with your question or tap below. Reply STOP to stop messages.",
      hi: "नमस्ते {{1}}, {{2}} से। क्या आप अभी भी {{3}} के बारे में सोच रहे हैं? ज़्यादातर लोग जानना चाहते हैं कि खर्च कितना होगा, दर्द होगा या नहीं, और कितनी बार आना होगा। डॉक्टर एक छोटे परामर्श में तीनों का जवाब दे सकते हैं, इलाज कराने की कोई बाध्यता नहीं। अपना सवाल लिखें या नीचे दबाएँ। मैसेज बंद करने के लिए STOP लिखें।",
    },
    buttons: [
      { en: "Book a visit", hi: "विज़िट बुक करें" },
      { en: "Ask a question", hi: "सवाल पूछें" },
      { en: "Call me", hi: "मुझे कॉल करें" },
    ],
  },
  // After a visit: one question. The answer decides the next message (Google link, or the doctor calls).
  review_request: {
    purpose: "review_request",
    name: "sentio_review_request",
    category: "marketing",
    params: ["first name", "clinic name"],
    body: {
      en: "Namaste {{1}}, thank you for visiting {{2}} today. How was your visit? Your answer helps us improve. Reply STOP to stop messages.",
      hi: "नमस्ते {{1}}, आज {{2}} आने के लिए धन्यवाद। आपकी विज़िट कैसी रही? आपका जवाब हमें बेहतर बनने में मदद करता है। मैसेज बंद करने के लिए STOP लिखें।",
    },
    buttons: [
      { en: "Very good 👍", hi: "बहुत अच्छी 👍" },
      { en: "Could be better", hi: "और बेहतर हो सकती थी" },
    ],
  },
  // The owner's 9 pm summary (Phase 6).
  owner_daily_report: {
    purpose: "owner_daily_report",
    name: "sentio_owner_daily_report",
    category: "utility",
    params: ["owner name", "clinic name", "the day in numbers", "report link"],
    body: {
      en: "{{1}}, today at {{2}}: {{3}} Full report: {{4}}",
      hi: "{{1}}, {{2}} में आज: {{3}} पूरी रिपोर्ट: {{4}}",
    },
  },
  prescription: {
    purpose: "prescription",
    name: "sentio_prescription",
    category: "utility",
    params: ["patient name", "doctor name", "clinic name", "prescription link"],
    body: {
      en: "{{1}}, your prescription from {{2}} at {{3}}: {{4}} Please take medicines only as written.",
      hi: "{{1}}, {{3}} में {{2}} का आपका पर्चा: {{4}} कृपया दवाएँ केवल पर्चे के अनुसार ही लें।",
    },
  },
};

export function renderTemplate(purpose: TemplatePurpose, language: "en" | "hi", params: string[]): string {
  return TEMPLATES[purpose].body[language].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => params[Number(n) - 1] ?? "",
  );
}

/** Adds any standard template the clinic doesn't have yet (new ones arrive with updates). Keeps approvals. */
export async function registerStandardTemplates(client: PoolClient): Promise<void> {
  for (const t of Object.values(TEMPLATES)) {
    for (const language of ["en", "hi"] as const) {
      await client.query(
        `insert into message_templates (clinic_id, purpose, name, language, category, body, buttons)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6) on conflict (clinic_id, purpose, language) do nothing`,
        [
          t.purpose,
          t.name,
          language,
          t.category,
          t.body[language],
          JSON.stringify((t.buttons ?? []).map((b) => b[language])),
        ],
      );
    }
  }
}

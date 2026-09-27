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
  | "staff_alert";

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
};

export function renderTemplate(purpose: TemplatePurpose, language: "en" | "hi", params: string[]): string {
  return TEMPLATES[purpose].body[language].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => params[Number(n) - 1] ?? "",
  );
}

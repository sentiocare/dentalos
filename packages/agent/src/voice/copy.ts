/**
 * Everything the phone assistant says, in English and Hindi. Hindi is written in Devanagari as people
 * actually speak it (English words like "appointment" and "doctor" kept), because the speech engine
 * pronounces Devanagari naturally. Hinglish callers hear the Hindi lines. Short sentences: people cannot
 * scroll back on a phone call. Written by people, filled in by code; the language model never writes them.
 */
export type VoiceLang = "en" | "hi";
type Params = Record<string, string>;

const T = {
  greeting: {
    en: "Namaste, thank you for calling {clinic}. I'm the clinic's digital assistant. This call may be recorded for quality, and your details are used only for your treatment.",
    hi: "नमस्ते, {clinic} में फ़ोन करने के लिए धन्यवाद। मैं क्लिनिक की डिजिटल असिस्टेंट हूँ। यह कॉल क्वालिटी के लिए रिकॉर्ड हो सकती है, और आपकी जानकारी सिर्फ़ आपके इलाज के लिए इस्तेमाल होगी।",
  },
  outbound_greeting: {
    en: "Namaste, this is the digital assistant of {clinic}. This call may be recorded.",
    hi: "नमस्ते, मैं {clinic} की डिजिटल असिस्टेंट बोल रही हूँ। यह कॉल रिकॉर्ड हो सकती है।",
  },
  outbound_confirm_q: {
    en: "{patient} has an appointment {when}, with {doctor}. Will you be able to come?",
    hi: "{patient} का appointment {when} है, {doctor} के साथ। क्या आप आ पाएँगे?",
  },
  outbound_confirmed: {
    en: "Thank you! Your appointment is confirmed. See you then.",
    hi: "धन्यवाद! आपका appointment पक्का है। मिलते हैं।",
  },
  outbound_change_q: {
    en: "No problem. Shall I move it to another time, or cancel it?",
    hi: "कोई बात नहीं। क्या मैं समय बदल दूँ, या appointment cancel कर दूँ?",
  },
  outbound_staff_will_call: {
    en: "Alright. The clinic staff will call you to sort it out. Thank you!",
    hi: "ठीक है। क्लिनिक स्टाफ़ आपको फ़ोन करके बात कर लेंगे। धन्यवाद!",
  },
  voice_optout: {
    en: "Sorry for the trouble. The clinic will not call you with automatic calls again. You can still call the clinic any time.",
    hi: "परेशानी के लिए माफ़ी। क्लिनिक आपको अब अपने आप वाली कॉल नहीं करेगा। आप कभी भी क्लिनिक को फ़ोन कर सकते हैं।",
  },
  how_help: {
    en: "How can I help you?",
    hi: "बताइए, मैं आपकी क्या मदद कर सकती हूँ?",
  },
  anything_else: { en: "Is there anything else I can help with?", hi: "और कुछ मदद कर सकती हूँ?" },
  goodbye: {
    en: "Thank you for calling {clinic}. Take care!",
    hi: "{clinic} में फ़ोन करने के लिए धन्यवाद। अपना ध्यान रखिए!",
  },
  still_there: { en: "Are you still there?", hi: "क्या आप लाइन पर हैं?" },
  no_input_bye: {
    en: "I can't hear you, so I'll end the call now. You can call again or message us on WhatsApp.",
    hi: "मुझे आपकी आवाज़ नहीं आ रही, इसलिए मैं कॉल रख रही हूँ। आप दोबारा फ़ोन कर सकते हैं या WhatsApp पर मैसेज कर सकते हैं।",
  },
  repeat: {
    en: "Sorry, I didn't catch that. Could you say it again?",
    hi: "माफ़ कीजिए, मैं ठीक से सुन नहीं पाई। एक बार फिर बोलिए?",
  },
  not_understood: {
    en: "Sorry, I didn't understand. You can ask me to book, change or cancel an appointment, or about timings, address and fees.",
    hi: "माफ़ कीजिए, मैं समझ नहीं पाई। आप appointment बुक करने, बदलने या cancel करने के लिए, या टाइमिंग, पता और फ़ीस के बारे में पूछ सकते हैं।",
  },
  offer_staff: {
    en: "Shall I connect you to the clinic staff?",
    hi: "क्या मैं आपको क्लिनिक स्टाफ़ से जोड़ दूँ?",
  },
  connecting_staff: {
    en: "Sure, I'm connecting you to the clinic staff. Please stay on the line.",
    hi: "जी, मैं आपको क्लिनिक स्टाफ़ से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।",
  },
  callback_promise: {
    en: "The clinic staff will call you back soon on this number.",
    hi: "क्लिनिक स्टाफ़ जल्दी ही आपको इसी नंबर पर वापस फ़ोन करेंगे।",
  },
  emergency_life: {
    en: "This sounds serious. If there is difficulty breathing or swallowing, call 112 now or go to the nearest hospital. I'm connecting you to the doctor right away. Please stay on the line.",
    hi: "यह गंभीर लग रहा है। अगर साँस लेने या निगलने में दिक्कत है, तो अभी 112 पर फ़ोन करें या नज़दीकी अस्पताल जाएँ। मैं आपको तुरंत डॉक्टर से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।",
  },
  emergency_urgent: {
    en: "This needs quick attention. I'm connecting you to the doctor right away. Please stay on the line.",
    hi: "इसमें जल्दी ध्यान देना ज़रूरी है। मैं आपको तुरंत डॉक्टर से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।",
  },
  emergency_no_one: {
    en: "I've alerted the doctor, and the clinic will call you back within minutes. If it gets worse, go to the nearest hospital.",
    hi: "मैंने डॉक्टर को खबर कर दी है, क्लिनिक कुछ ही मिनट में आपको वापस फ़ोन करेगा। अगर तकलीफ़ बढ़े, तो नज़दीकी अस्पताल जाइए।",
  },
  bot_disclosure: {
    en: "I'm the clinic's digital assistant, not a person. I can book appointments and tell you timings, address and fees. I can also connect you to the staff.",
    hi: "मैं क्लिनिक की डिजिटल असिस्टेंट हूँ, कोई इंसान नहीं। मैं appointment बुक कर सकती हूँ और टाइमिंग, पता और फ़ीस बता सकती हूँ। चाहें तो मैं आपको स्टाफ़ से भी जोड़ सकती हूँ।",
  },
  medical: {
    en: "I can't give medical advice; the doctor will tell you after checking. If the pain is severe or there is swelling, please say so. Shall I book a consultation?",
    hi: "मैं इलाज की सलाह नहीं दे सकती; डॉक्टर देखकर ही बताएँगे। अगर दर्द बहुत ज़्यादा है या सूजन है, तो बताइए। क्या मैं consultation बुक कर दूँ?",
  },
  ask_name: { en: "May I have the patient's name, please?", hi: "मरीज़ का नाम बताइए?" },
  ask_name_again: { en: "Sorry, could you tell me the name again?", hi: "माफ़ कीजिए, नाम एक बार फिर बताइए?" },
  ask_name_relation: { en: "What is your {relation}'s name?", hi: "आपके {relation} का नाम क्या है?" },
  confirm_patient: { en: "Is the appointment for {name}?", hi: "क्या appointment {name} के लिए है?" },
  ask_who: {
    en: "Who is the appointment for? {names}, or someone else?",
    hi: "Appointment किसके लिए है? {names}, या किसी और के लिए?",
  },
  ask_reason: {
    en: "What is the visit for? For example pain, cleaning, or a check-up.",
    hi: "किस काम के लिए आना है? जैसे दर्द, सफ़ाई, या चेकअप।",
  },
  offer_two: {
    en: "For {procedure}, I have {a}, or {b}. Which one suits you?",
    hi: "{procedure} के लिए {a} या {b} खाली है। कौन-सा ठीक रहेगा?",
  },
  offer_one: {
    en: "For {procedure}, the next free time is {a}. Shall I book it?",
    hi: "{procedure} के लिए अगला खाली समय {a} है। क्या यह बुक कर दूँ?",
  },
  no_slots_then: {
    en: "There's nothing free then.",
    hi: "उस समय कुछ खाली नहीं है।",
  },
  no_slots_at_all: {
    en: "I couldn't find a free time. The clinic staff will call you to fix one.",
    hi: "मुझे कोई खाली समय नहीं मिला। क्लिनिक स्टाफ़ आपको फ़ोन करके समय तय करेंगे।",
  },
  pick_one: {
    en: "Please say first or second, or tell me another day or time.",
    hi: "पहला या दूसरा बोलिए, या कोई और दिन या समय बताइए।",
  },
  readback: {
    en: "So that's {patient}, {when}, with {doctor}. Shall I book it?",
    hi: "तो {patient}, {when}, {doctor} के साथ। बुक कर दूँ?",
  },
  readback_reschedule: {
    en: "So I'll move {patient}'s appointment to {when}, with {doctor}. Shall I do that?",
    hi: "तो {patient} का appointment {when} पर कर दूँ, {doctor} के साथ?",
  },
  booked: {
    en: "Done! The appointment is booked for {when}. You'll get a confirmation on WhatsApp.",
    hi: "हो गया! Appointment {when} के लिए बुक हो गया है। आपको WhatsApp पर confirmation मिल जाएगा।",
  },
  rescheduled: {
    en: "Done! The appointment is now {when}. You'll get the details on WhatsApp.",
    hi: "हो गया! Appointment अब {when} का है। आपको WhatsApp पर जानकारी मिल जाएगी।",
  },
  slot_gone: {
    en: "Sorry, that time was just taken. Let me find another.",
    hi: "माफ़ कीजिए, वह समय अभी-अभी भर गया। मैं दूसरा समय देखती हूँ।",
  },
  other_time: { en: "Sure. Which day or time would suit you?", hi: "ठीक है। कौन-सा दिन या समय ठीक रहेगा?" },
  no_upcoming: {
    en: "I couldn't find an upcoming appointment for this number. Shall I book a new one?",
    hi: "इस नंबर पर कोई आने वाला appointment नहीं मिला। क्या नया बुक कर दूँ?",
  },
  your_appointment: {
    en: "Your appointment is {when}, with {doctor}.",
    hi: "आपका appointment {when} है, {doctor} के साथ।",
  },
  which_appointment: {
    en: "You have {count} appointments: first, {a}; second, {b}. Which one?",
    hi: "आपके {count} appointment हैं: पहला {a}, दूसरा {b}। कौन-सा?",
  },
  confirm_cancel: {
    en: "Shall I cancel {patient}'s appointment on {when}?",
    hi: "क्या मैं {patient} का {when} वाला appointment cancel कर दूँ?",
  },
  cancelled: {
    en: "It's cancelled. Would you like to book another time?",
    hi: "Appointment cancel हो गया है। क्या कोई और समय बुक करना है?",
  },
  kept: { en: "Okay, I've kept the appointment as it is.", hi: "ठीक है, appointment वैसे ही रहेगा।" },
  confirmed_attendance: {
    en: "Thank you, your appointment on {when} is confirmed.",
    hi: "धन्यवाद, आपका {when} वाला appointment पक्का है।",
  },
  timings: { en: "The clinic is open {hours}.", hi: "क्लिनिक {hours} खुला रहता है।" },
  closed_on: { en: "It's closed on {days}.", hi: "{days} को बंद रहता है।" },
  holiday: {
    en: "Please note, the clinic is closed on {list}.",
    hi: "ध्यान दें, क्लिनिक {list} को बंद रहेगा।",
  },
  address: { en: "The clinic's address is {address}.", hi: "क्लिनिक का पता है: {address}।" },
  address_unknown: {
    en: "I don't have the address with me. The staff will share it.",
    hi: "मेरे पास पता नहीं है। स्टाफ़ आपको बता देंगे।",
  },
  price_range: {
    en: "{procedure} usually costs between {min} and {max} rupees. The doctor will confirm the exact amount after checking.",
    hi: "{procedure} का ख़र्च आमतौर पर {min} से {max} रुपये के बीच होता है। सही रकम डॉक्टर देखकर बताएँगे।",
  },
  price_unknown: {
    en: "The doctor will tell you the exact cost at a consultation. Shall I book one?",
    hi: "सही ख़र्च डॉक्टर consultation में बताएँगे। क्या मैं consultation बुक कर दूँ?",
  },
  price_which: { en: "Which treatment would you like the cost for?", hi: "किस इलाज का ख़र्च जानना है?" },
  doctors: { en: "Our doctors are {list}.", hi: "हमारे डॉक्टर हैं: {list}।" },
  ok_listening: { en: "Yes, please go ahead.", hi: "जी, बताइए।" },
  thanks_reply: { en: "You're welcome!", hi: "आपका स्वागत है!" },
  switched_en: { en: "Sure, let's continue in English.", hi: "Sure, let's continue in English." },
  switched_hi: { en: "ठीक है, हिंदी में बात करते हैं।", hi: "ठीक है, हिंदी में बात करते हैं।" },
  filler: { en: "One moment, please.", hi: "जी, एक सेकंड।" },
  safe_fallback: {
    en: "Let me have the clinic staff help you with that. They'll call you back soon.",
    hi: "इसमें क्लिनिक स्टाफ़ आपकी मदद करेंगे। वे जल्दी ही आपको फ़ोन करेंगे।",
  },
  too_long: {
    en: "Let me connect you to the staff so they can help you further.",
    hi: "आगे की मदद के लिए मैं आपको स्टाफ़ से जोड़ रही हूँ।",
  },
} satisfies Record<string, Record<VoiceLang, string>>;

export type VoiceCopyKey = keyof typeof T;

export function voiceSay(lang: VoiceLang, key: VoiceCopyKey, params: Params = {}): string {
  return T[key][lang].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "");
}

export const VOICE_COPY_KEYS = Object.keys(T) as VoiceCopyKey[];

const RELATIONS: Record<string, Record<VoiceLang, string>> = {
  father: { en: "father", hi: "पिताजी" },
  mother: { en: "mother", hi: "माताजी" },
  son: { en: "son", hi: "बेटे" },
  daughter: { en: "daughter", hi: "बेटी" },
  wife: { en: "wife", hi: "पत्नी" },
  husband: { en: "husband", hi: "पति" },
  brother: { en: "brother", hi: "भाई" },
  sister: { en: "sister", hi: "बहन" },
  grandmother: { en: "grandmother", hi: "दादी/नानी" },
  grandfather: { en: "grandfather", hi: "दादा/नाना" },
  child: { en: "child", hi: "बच्चे" },
};
export const spokenRelation = (relation: string, lang: VoiceLang) => RELATIONS[relation]?.[lang] ?? relation;

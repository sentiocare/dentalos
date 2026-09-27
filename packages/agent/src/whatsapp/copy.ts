import type { Lang } from "@dentalos/core";

/**
 * Everything the WhatsApp assistant says, in English, Hindi and Hinglish. Written by people, filled in by
 * code; the language model never writes patient-facing text. Respectful ("aap", "ji"), short, and free of
 * promises or medical wording (Build Prompt §6.1, §6.5). Button titles stay within 20 characters.
 */
type Params = Record<string, string>;
type Entry = Record<Lang, string>;

const T = {
  consent_notice: {
    en: "Namaste! You are chatting with {clinic}'s digital assistant. {clinic} uses your name, phone number and appointment details only for your dental care: bookings, reminders, receipts and follow-ups. Messages may be processed by our technology partner Sentio Care on the clinic's behalf. Reply STOP anytime to stop messages.\n\nTap *Agree* to continue.",
    hi: "नमस्ते! आप {clinic} की डिजिटल असिस्टेंट से बात कर रहे हैं। {clinic} आपका नाम, फ़ोन नंबर और अपॉइंटमेंट की जानकारी सिर्फ़ आपके दाँतों के इलाज के लिए इस्तेमाल करता है: बुकिंग, रिमाइंडर, रसीद और फ़ॉलो-अप। यह जानकारी क्लिनिक की ओर से हमारे टेक्नोलॉजी पार्टनर Sentio Care द्वारा प्रोसेस की जा सकती है। मैसेज बंद करने के लिए कभी भी STOP लिखें।\n\nआगे बढ़ने के लिए *सहमत* दबाएँ।",
    hinglish:
      "Namaste! Aap {clinic} ki digital assistant se baat kar rahe hain. {clinic} aapka naam, phone number aur appointment ki jaankari sirf aapke daanton ke ilaaj ke liye use karta hai: booking, reminder, receipt aur follow-up. Ye jaankari clinic ki taraf se hamare technology partner Sentio Care dwara process ki ja sakti hai. Message band karne ke liye kabhi bhi STOP likhein.\n\nAage badhne ke liye *Agree* dabayein.",
  },
  btn_agree: { en: "Agree", hi: "सहमत", hinglish: "Agree" },
  btn_book: { en: "Book appointment", hi: "अपॉइंटमेंट बुक करें", hinglish: "Appointment book" },
  btn_info: { en: "Timings & address", hi: "समय और पता", hinglish: "Timing aur address" },
  btn_staff: { en: "Talk to staff", hi: "स्टाफ़ से बात", hinglish: "Staff se baat" },
  btn_yes_book: { en: "Yes, book it", hi: "हाँ, बुक करें", hinglish: "Haan, book karein" },
  btn_other_time: { en: "Other time", hi: "दूसरा समय", hinglish: "Doosra time" },
  btn_more_dates: { en: "Later dates", hi: "आगे की तारीखें", hinglish: "Aage ki dates" },
  btn_someone_else: { en: "Someone else", hi: "कोई और", hinglish: "Koi aur" },
  btn_yes_cancel: { en: "Yes, cancel", hi: "हाँ, रद्द करें", hinglish: "Haan, cancel" },
  btn_keep: { en: "Keep it", hi: "रहने दें", hinglish: "Rehne dein" },
  btn_reschedule: { en: "Change time", hi: "समय बदलें", hinglish: "Time badlein" },
  btn_cancel: { en: "Cancel it", hi: "रद्द करें", hinglish: "Cancel karein" },
  btn_consultation: { en: "Book consultation", hi: "परामर्श बुक करें", hinglish: "Consultation book" },
  welcome: {
    en: "Namaste! I'm the digital assistant of {clinic}. How can I help you?",
    hi: "नमस्ते! मैं {clinic} की डिजिटल असिस्टेंट हूँ। मैं आपकी क्या मदद कर सकती हूँ?",
    hinglish: "Namaste! Main {clinic} ki digital assistant hoon. Main aapki kya madad kar sakti hoon?",
  },
  bot_disclosure: {
    en: "I'm {clinic}'s digital assistant, not a person. I can book appointments and share timings, address and prices. If you prefer, the clinic staff can talk to you.",
    hi: "मैं {clinic} की डिजिटल असिस्टेंट हूँ, कोई इंसान नहीं। मैं अपॉइंटमेंट बुक कर सकती हूँ और समय, पता व कीमतें बता सकती हूँ। चाहें तो क्लिनिक का स्टाफ़ आपसे बात कर सकता है।",
    hinglish:
      "Main {clinic} ki digital assistant hoon, koi insaan nahi. Main appointment book kar sakti hoon aur timing, address aur price bata sakti hoon. Aap chahein to clinic ka staff aapse baat kar sakta hai.",
  },
  ask_who: {
    en: "Who is the appointment for?",
    hi: "अपॉइंटमेंट किसके लिए है?",
    hinglish: "Appointment kiske liye hai?",
  },
  ask_name: {
    en: "Please tell me the patient's full name.",
    hi: "कृपया मरीज़ का पूरा नाम बताइए।",
    hinglish: "Kripya patient ka poora naam bataiye.",
  },
  ask_name_relation: {
    en: "Please tell me your {relation}'s full name.",
    hi: "कृपया अपने {relation} का पूरा नाम बताइए।",
    hinglish: "Kripya apne {relation} ka poora naam bataiye.",
  },
  ask_reason: {
    en: "What is the visit for? For example: checkup, tooth pain, cleaning, RCT, braces.",
    hi: "किस काम के लिए आना है? जैसे: जाँच, दाँत में दर्द, सफ़ाई, RCT, ब्रेसेस।",
    hinglish: "Kis kaam ke liye aana hai? Jaise: checkup, daant mein dard, safai, RCT, braces.",
  },
  offer_slots: {
    en: "These times are free for {procedure}. Please choose one:",
    hi: "{procedure} के लिए ये समय खाली हैं। कृपया एक चुनें:",
    hinglish: "{procedure} ke liye ye time khaali hain. Kripya ek chuniye:",
  },
  no_slots: {
    en: "Sorry, there is no free time on those days. Would you like to see later dates, or tell me another day?",
    hi: "माफ़ कीजिए, उन दिनों में कोई समय खाली नहीं है। आगे की तारीखें देखें, या कोई और दिन बताइए?",
    hinglish:
      "Maaf kijiye, un dinon mein koi time khaali nahi hai. Aage ki dates dekhein, ya koi aur din bataiye?",
  },
  no_slots_at_all: {
    en: "Sorry, I couldn't find a free time in the next two weeks. I've asked the clinic team to call you to fix a time.",
    hi: "माफ़ कीजिए, अगले दो हफ़्तों में कोई समय खाली नहीं मिला। मैंने क्लिनिक टीम से कहा है कि वे आपको कॉल करके समय तय करें।",
    hinglish:
      "Maaf kijiye, agle do hafton mein koi time khaali nahi mila. Maine clinic team se kaha hai ki woh aapko call karke time tay karein.",
  },
  confirm_booking: {
    en: "Please confirm:\n*{patient}*\n{when}\nwith {doctor}\n\nShall I book it?",
    hi: "कृपया पक्का करें:\n*{patient}*\n{when}\n{doctor} के साथ\n\nक्या बुक कर दूँ?",
    hinglish: "Kripya confirm karein:\n*{patient}*\n{when}\n{doctor} ke saath\n\nKya book kar doon?",
  },
  booked: {
    en: "Done! {patient}'s appointment is booked for {when} with {doctor} at {clinic}. We'll remind you a day before. Reply here if you need to change it.",
    hi: "हो गया! {patient} का अपॉइंटमेंट {when} को {doctor} के साथ {clinic} में बुक हो गया है। एक दिन पहले याद दिलाएँगे। बदलना हो तो यहीं जवाब दें।",
    hinglish:
      "Ho gaya! {patient} ka appointment {when} ko {doctor} ke saath {clinic} mein book ho gaya hai. Ek din pehle yaad dilayenge. Badalna ho to yahin reply karein.",
  },
  slot_gone: {
    en: "Sorry, that time was just taken by someone else. Here are other free times:",
    hi: "माफ़ कीजिए, वह समय अभी किसी और ने ले लिया। ये दूसरे खाली समय हैं:",
    hinglish: "Maaf kijiye, woh time abhi kisi aur ne le liya. Ye doosre khaali time hain:",
  },
  pick_from_buttons: {
    en: "Please tap one of the times above, or tell me another day.",
    hi: "कृपया ऊपर दिए किसी समय पर टैप करें, या कोई और दिन बताइए।",
    hinglish: "Kripya upar diye kisi time par tap karein, ya koi aur din bataiye.",
  },
  your_appointments: {
    en: "Upcoming appointments:\n{list}",
    hi: "आने वाले अपॉइंटमेंट:\n{list}",
    hinglish: "Aane wale appointments:\n{list}",
  },
  no_upcoming: {
    en: "I don't see any upcoming appointment for this number. Would you like to book one?",
    hi: "इस नंबर पर कोई आने वाला अपॉइंटमेंट नहीं दिख रहा। क्या नया बुक करें?",
    hinglish: "Is number par koi aane wala appointment nahi dikh raha. Kya naya book karein?",
  },
  choose_appointment: {
    en: "Which appointment?",
    hi: "कौन सा अपॉइंटमेंट?",
    hinglish: "Kaun sa appointment?",
  },
  confirm_cancel: {
    en: "Cancel {patient}'s appointment on {when}?",
    hi: "{patient} का {when} का अपॉइंटमेंट रद्द करें?",
    hinglish: "{patient} ka {when} ka appointment cancel karein?",
  },
  cancelled: {
    en: "Cancelled. {patient}'s appointment on {when} is cancelled. You can book again here any time.",
    hi: "रद्द हो गया। {patient} का {when} का अपॉइंटमेंट रद्द कर दिया गया है। आप कभी भी यहाँ दोबारा बुक कर सकते हैं।",
    hinglish:
      "Cancel ho gaya. {patient} ka {when} ka appointment cancel kar diya gaya hai. Aap kabhi bhi yahan dobara book kar sakte hain.",
  },
  kept: {
    en: "Okay, your appointment stays as it is.",
    hi: "ठीक है, आपका अपॉइंटमेंट जैसा है वैसा ही रहेगा।",
    hinglish: "Theek hai, aapka appointment jaisa hai waisa hi rahega.",
  },
  confirm_reschedule: {
    en: "Move {patient}'s appointment to:\n{when}\nwith {doctor}?",
    hi: "{patient} का अपॉइंटमेंट इस समय पर करें:\n{when}\n{doctor} के साथ?",
    hinglish: "{patient} ka appointment is time par karein:\n{when}\n{doctor} ke saath?",
  },
  rescheduled: {
    en: "Done! {patient}'s appointment is now on {when} with {doctor}.",
    hi: "हो गया! {patient} का अपॉइंटमेंट अब {when} को {doctor} के साथ है।",
    hinglish: "Ho gaya! {patient} ka appointment ab {when} ko {doctor} ke saath hai.",
  },
  reminder_confirmed: {
    en: "Thank you! Your appointment on {when} is confirmed. See you then.",
    hi: "धन्यवाद! {when} का आपका अपॉइंटमेंट पक्का हो गया। मिलते हैं।",
    hinglish: "Dhanyavaad! {when} ka aapka appointment pakka ho gaya. Milte hain.",
  },
  timings: {
    en: "{clinic} timings:\n{hours}{holidays}",
    hi: "{clinic} का समय:\n{hours}{holidays}",
    hinglish: "{clinic} ki timing:\n{hours}{holidays}",
  },
  closed_word: { en: "Closed", hi: "बंद", hinglish: "Band" },
  holiday_line: {
    en: "\nClosed on: {list}",
    hi: "\nइन दिनों बंद: {list}",
    hinglish: "\nIn dinon band: {list}",
  },
  location: {
    en: "{clinic}\n{address}{maps}",
    hi: "{clinic}\n{address}{maps}",
    hinglish: "{clinic}\n{address}{maps}",
  },
  location_missing: {
    en: "I'll ask the clinic team to send you the address and directions.",
    hi: "मैं क्लिनिक टीम से कहती हूँ कि वे आपको पता और रास्ता भेजें।",
    hinglish: "Main clinic team se kehti hoon ki woh aapko address aur rasta bhejein.",
  },
  price: {
    en: "{procedure} usually costs between {min} and {max}. The exact amount will be told by the doctor after checking.",
    hi: "{procedure} का खर्च आमतौर पर {min} से {max} के बीच होता है। सही रकम डॉक्टर जाँच के बाद बताएँगे।",
    hinglish:
      "{procedure} ka kharcha usually {min} se {max} ke beech hota hai. Exact amount doctor check karke batayenge.",
  },
  price_unknown: {
    en: "The doctor will give you an exact estimate at a consultation. Would you like to book one?",
    hi: "सही अनुमान डॉक्टर परामर्श में बताएँगे। क्या परामर्श बुक करें?",
    hinglish: "Iske liye doctor se consultation mein exact estimate milega. Kya consultation book karein?",
  },
  price_which: {
    en: "Which treatment would you like the price for? For example: RCT, cleaning, filling, extraction.",
    hi: "किस इलाज की कीमत जाननी है? जैसे: RCT, सफ़ाई, फ़िलिंग, दाँत निकालना।",
    hinglish: "Kis treatment ka price jaanna hai? Jaise: RCT, safai, filling, daant nikalna.",
  },
  doctors: {
    en: "Our doctors:\n{list}",
    hi: "हमारे डॉक्टर:\n{list}",
    hinglish: "Hamare doctors:\n{list}",
  },
  human_ack: {
    en: "I've asked the clinic team to get back to you. They will reply here or call you soon.",
    hi: "मैंने क्लिनिक टीम से कहा है। वे जल्द यहीं जवाब देंगे या आपको कॉल करेंगे।",
    hinglish: "Maine clinic team se keh diya hai. Woh jaldi yahin reply karenge ya aapko call karenge.",
  },
  unknown: {
    en: "Sorry, I didn't fully understand. I can book appointments and share timings, address and prices, or connect you to the staff.",
    hi: "माफ़ कीजिए, मैं पूरी तरह समझ नहीं पाई। मैं अपॉइंटमेंट बुक कर सकती हूँ, समय, पता और कीमतें बता सकती हूँ, या स्टाफ़ से बात करवा सकती हूँ।",
    hinglish:
      "Maaf kijiye, main poori tarah samajh nahi paayi. Main appointment book kar sakti hoon, timing, address aur price bata sakti hoon, ya staff se baat karwa sakti hoon.",
  },
  stopped: {
    en: "Okay. You won't get reminders or updates from {clinic} on WhatsApp anymore. Reply START if you want them again.",
    hi: "ठीक है। अब आपको {clinic} से WhatsApp पर रिमाइंडर या अपडेट नहीं आएँगे। फिर से चाहें तो START लिखें।",
    hinglish:
      "Theek hai. Ab aapko {clinic} se WhatsApp par reminder ya update nahi aayenge. Dobara chahiye to START likhein.",
  },
  started: {
    en: "Welcome back! You will get appointment reminders from {clinic} again.",
    hi: "आपका फिर से स्वागत है! {clinic} से अपॉइंटमेंट रिमाइंडर फिर से मिलेंगे।",
    hinglish: "Aapka phir se swagat hai! {clinic} se appointment reminder phir se milenge.",
  },
  emergency_life: {
    en: "This may need urgent medical help. Please go to the nearest hospital emergency now or call 112. We have also alerted the doctor.",
    hi: "इसमें तुरंत डॉक्टरी मदद की ज़रूरत हो सकती है। कृपया अभी नज़दीकी अस्पताल की इमरजेंसी में जाएँ या 112 पर कॉल करें। हमने डॉक्टर को भी सूचना दे दी है।",
    hinglish:
      "Isme turant medical madad ki zaroorat ho sakti hai. Kripya abhi nazdeeki hospital ki emergency mein jaayein ya 112 par call karein. Humne doctor ko bhi bata diya hai.",
  },
  emergency_urgent: {
    en: "We have alerted the doctor right away. The doctor or clinic will call you shortly on this number. If breathing or swallowing becomes difficult, go to the nearest hospital emergency or call 112.",
    hi: "हमने डॉक्टर को तुरंत सूचना दे दी है। डॉक्टर या क्लिनिक जल्द इसी नंबर पर कॉल करेंगे। अगर साँस लेने या निगलने में दिक्कत हो, तो नज़दीकी अस्पताल की इमरजेंसी में जाएँ या 112 पर कॉल करें।",
    hinglish:
      "Humne doctor ko turant bata diya hai. Doctor ya clinic jaldi isi number par call karenge. Agar saans lene ya nigalne mein dikkat ho, to nazdeeki hospital ki emergency mein jaayein ya 112 par call karein.",
  },
  thanks_reply: { en: "You're welcome! 🙏", hi: "आपका स्वागत है! 🙏", hinglish: "Aapka swagat hai! 🙏" },
  voice_failed: {
    en: "Sorry, I couldn't listen to the voice note. Could you please type your message?",
    hi: "माफ़ कीजिए, मैं वॉइस नोट नहीं सुन पाई। क्या आप मैसेज लिखकर भेज सकते हैं?",
    hinglish: "Maaf kijiye, main voice note sun nahi paayi. Kya aap message likh kar bhej sakte hain?",
  },
  media_received: {
    en: "Thank you, we have received it. The clinic team will look at it.",
    hi: "धन्यवाद, हमें मिल गया। क्लिनिक टीम इसे देखेगी।",
    hinglish: "Dhanyavaad, humein mil gaya. Clinic team ise dekhegi.",
  },
  safe_fallback: {
    en: "I'll pass this to the clinic team; they will reply to you here shortly.",
    hi: "मैं यह क्लिनिक टीम तक पहुँचा देती हूँ; वे जल्द यहीं जवाब देंगे।",
    hinglish: "Main ye clinic team tak pahuncha deti hoon; woh jaldi yahin reply karenge.",
  },
} satisfies Record<string, Entry>;

export type CopyKey = keyof typeof T;

export function say(lang: Lang, key: CopyKey, params: Params = {}): string {
  return T[key][lang].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "");
}

const RELATION_WORDS: Record<string, Record<Lang, string>> = {
  father: { en: "father", hi: "पिता जी", hinglish: "papa" },
  mother: { en: "mother", hi: "माता जी", hinglish: "mummy" },
  son: { en: "son", hi: "बेटे", hinglish: "bete" },
  daughter: { en: "daughter", hi: "बेटी", hinglish: "beti" },
  wife: { en: "wife", hi: "पत्नी", hinglish: "wife" },
  husband: { en: "husband", hi: "पति", hinglish: "husband" },
  brother: { en: "brother", hi: "भाई", hinglish: "bhai" },
  sister: { en: "sister", hi: "बहन", hinglish: "behen" },
  grandmother: { en: "grandmother", hi: "दादी/नानी", hinglish: "dadi/nani" },
  grandfather: { en: "grandfather", hi: "दादा/नाना", hinglish: "dada/nana" },
  child: { en: "child", hi: "बच्चे", hinglish: "bachche" },
};

export function relationWord(relation: string, lang: Lang): string {
  return RELATION_WORDS[relation]?.[lang] ?? relation;
}

export function allCopy() {
  return T;
}

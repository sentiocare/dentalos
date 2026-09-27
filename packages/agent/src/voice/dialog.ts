import type { LLMProvider } from "@dentalos/adapters";
import {
  addDays,
  bookFromHold,
  cancelAppointment,
  createPatient,
  DomainError,
  enqueueMessage,
  findPatientsByPhone,
  isLikelySamePerson,
  linkFamily,
  localDateOf,
  localMinutesOf,
  moveAppointment,
  offerSlots,
  releaseHolds,
  setAppointmentStatus,
  type Hold,
  type PartOfDay,
  type Patient,
} from "@dentalos/core";
import type { PoolClient } from "pg";
import { parseClockPreference } from "../nlu/clock";
import { detectLanguage } from "../nlu/language";
import { matchProcedure, understand, type ProcedureOption, type Understanding } from "../nlu/intents";
import { hasDevanagari, romanize } from "../nlu/romanize";
import { describeEmergency, detectEmergency } from "../safety/emergency";
import { checkOutput } from "../safety/output-filter";
import { spokenRelation, voiceSay, type VoiceCopyKey, type VoiceLang } from "./copy";
import { spokenClock, spokenList, spokenRupees, spokenWhen } from "./speak";

/**
 * The phone assistant (Build Prompt §5.1, §6). The same design as the WhatsApp assistant: a state machine
 * where code decides every step and chooses every sentence; the language model only helps understand
 * unclear speech. Each turn runs in one clinic-scoped transaction, so the caller is only told "booked"
 * after the booking is committed. Differences from chat: no buttons (yes/no, "first or second"),
 * two options instead of three (easier to remember), silence and mishearing handling, and transfers.
 */

export const VOICE_NOTICE_VERSION = "voice-v1";
const MAX_TURNS = 40;

export type VoiceInput =
  | { kind: "start" }
  | { kind: "speech"; text: string; language: string | null }
  /** The caller said nothing within the timeout. */
  | { kind: "no_input" }
  /** Speech was heard but could not be transcribed. */
  | { kind: "unclear" }
  | { kind: "dtmf"; digit: string };

export interface Utterance {
  text: string;
  /** Whether the caller may talk over it (legal notices and emergency scripts play in full). */
  interruptible: boolean;
}

export type Expect = "open" | "yes_no" | "name" | "choice";

export interface VoiceTurn {
  say: Utterance[];
  /** What kind of answer is expected next (the media server adjusts how long it waits for silence). */
  expect: Expect;
  end?: { kind: "hangup" } | { kind: "transfer"; to: "staff" | "emergency" };
  /** An appointment changed: the caller gets the WhatsApp confirmation after this turn commits. */
  planMessages: boolean;
  emergency: boolean;
}

export type CallOutcome =
  | "booked"
  | "rescheduled"
  | "cancelled"
  | "confirmed"
  | "information"
  | "transferred"
  | "callback"
  | "emergency"
  | "no_input";

interface HeldOption {
  holdId: string;
  start: string;
  end: string;
  doctorId: string;
}

export interface VoiceState {
  lang: VoiceLang;
  step?:
    | "who_confirm"
    | "who"
    | "name"
    | "reason"
    | "slots"
    | "confirm"
    | "appt_pick"
    | "cancel_confirm"
    | "price"
    | "anything_else"
    | "offer_book"
    | "offer_consult"
    | "offer_staff"
    | "outbound_confirm"
    | "outbound_change";
  flow?: "book" | "reschedule" | "cancel";
  lastQuestion?: { text: string; expect: Expect };
  patientId?: string;
  candidatePatientId?: string;
  newPatientName?: string;
  relationship?: string | null;
  procedureId?: string;
  fromDate?: string;
  toDate?: string;
  partsOfDay?: string[] | null;
  nearMinutes?: number | null;
  options?: HeldOption[];
  chosenHoldId?: string;
  appointmentId?: string;
  appointmentChoices?: string[];
  familyChoices?: { id: string; name: string }[];
  silences: number;
  misses: number;
  turns: number;
  consented?: boolean;
  intents: string[];
  outcome?: CallOutcome;
  bookedAppointmentId?: string;
  /** Plain-English notes of what happened, joined into the call summary. */
  notes: string[];
}

export interface ClinicFacts {
  name: string;
  timezone: string;
  address: string | null;
  phone: string | null;
  defaultLanguage: VoiceLang;
  emergencyTriggers: string[];
  staffPhones: string[];
  procedures: (ProcedureOption & {
    name: string;
    nameHi: string | null;
    priceMin: number | null;
    priceMax: number | null;
    pricePublic: boolean;
    isConsultation: boolean;
  })[];
}

export interface VoiceContext {
  client: PoolClient;
  callId: string;
  /** The caller's number (null when withheld). */
  phone: string | null;
  now: Date;
  llm?: LLMProvider;
  /** Why we placed this call (outbound calls only). */
  purpose?: "confirm_appointment" | null;
  /** The appointment an outbound call is about. */
  subjectId?: string | null;
}

/** Loaded once per call. */
export async function loadClinicFacts(client: PoolClient): Promise<ClinicFacts> {
  const c = (
    await client.query(
      "select name, timezone, address, phone, default_language, settings from clinics where id = app.current_clinic_id()",
    )
  ).rows[0];
  const procs = (
    await client.query(
      "select id, code, name, name_hi, synonyms, price_min_paise, price_max_paise, price_public, is_consultation from procedure_types where active order by sort_order",
    )
  ).rows;
  return {
    name: c.name,
    timezone: c.timezone,
    address: c.address,
    phone: c.phone,
    defaultLanguage: c.default_language === "en" ? "en" : "hi",
    emergencyTriggers: c.settings?.emergency?.extraTriggers ?? [],
    staffPhones: (c.settings?.voice?.staffPhones ?? []).filter(Boolean),
    procedures: procs.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      nameHi: p.name_hi,
      names: [p.name, p.name_hi, ...p.synonyms].filter(Boolean),
      priceMin: p.price_min_paise,
      priceMax: p.price_max_paise,
      pricePublic: p.price_public,
      isConsultation: p.is_consultation,
    })),
  };
}

export function initialVoiceState(facts: ClinicFacts): VoiceState {
  return { lang: facts.defaultLanguage, silences: 0, misses: 0, turns: 0, intents: [], notes: [] };
}

const HI_DAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DONE_WORDS = new Set(
  "no nope nothing thats that's all it else bas itna hi nahi nahin nai na kuch aur thanks thank you u dhanyavad dhanyavaad dhanyawad shukriya ok okay bye theek thik hai ji sab abhi".split(
    " ",
  ),
);
const CLOSING = /\b(no|nope|nothing|bas|nahi|nahin|nai|thanks|thank|dhanyavaa?d|dhanyawad|shukriya|bye)\b/;

/** "No, that's all", "नहीं, बस धन्यवाद", "bas itna hi ji": the caller is finished. */
export function isDone(text: string): boolean {
  const words = romanize(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 8 &&
    words.every((w) => DONE_WORDS.has(w)) &&
    CLOSING.test(words.join(" "))
  );
}

export class VoiceDialog {
  private out: Utterance[] = [];
  private expectNext: Expect = "open";
  private endAction: VoiceTurn["end"];
  private plan = false;
  private emergency = false;
  private ctx!: VoiceContext;

  constructor(
    private readonly facts: ClinicFacts,
    readonly state: VoiceState,
  ) {}

  // ---------------------------------------------------------------- helpers

  private get s() {
    return this.state;
  }

  private get q() {
    return this.ctx.client;
  }

  private t(key: VoiceCopyKey, params: Record<string, string> = {}) {
    return voiceSay(this.s.lang, key, { clinic: this.facts.name, ...params });
  }

  /** A statement. */
  private say(text: string, interruptible = true) {
    this.out.push({ text, interruptible });
  }

  /** A question: remembered so it can be repeated after silence. */
  private ask(text: string, expect: Expect = "open") {
    this.out.push({ text, interruptible: true });
    this.expectNext = expect;
    this.s.lastQuestion = { text, expect };
  }

  private when(iso: string | Date) {
    return spokenWhen(new Date(iso), this.facts.timezone, this.s.lang, this.ctx.now);
  }

  private today() {
    return localDateOf(this.ctx.now, this.facts.timezone);
  }

  private procedureName(id: string | null | undefined) {
    const p = this.facts.procedures.find((x) => x.id === id);
    if (!p) return "";
    return this.s.lang === "hi" && p.nameHi ? p.nameHi : p.name;
  }

  private consultationId() {
    return (
      this.facts.procedures.find((p) => p.code === "consultation") ??
      this.facts.procedures.find((p) => p.isConsultation)
    )?.id;
  }

  private note(text: string) {
    this.s.notes.push(text);
  }

  private resetFlow() {
    this.s.step = undefined;
    this.s.flow = undefined;
    this.s.patientId = undefined;
    this.s.candidatePatientId = undefined;
    this.s.newPatientName = undefined;
    this.s.relationship = undefined;
    this.s.procedureId = undefined;
    this.s.fromDate = undefined;
    this.s.toDate = undefined;
    this.s.partsOfDay = undefined;
    this.s.nearMinutes = undefined;
    this.s.options = undefined;
    this.s.chosenHoldId = undefined;
    this.s.appointmentId = undefined;
    this.s.appointmentChoices = undefined;
    this.s.familyChoices = undefined;
  }

  private anythingElse() {
    this.s.step = "anything_else";
    this.ask(this.t("anything_else"), "yes_no");
  }

  private async task(
    kind: string,
    priority: string,
    title: string,
    detail: string,
    dedupe: string,
    extra: { patientId?: string | null; appointmentId?: string | null } = {},
  ) {
    const patientId = extra.patientId ?? this.s.patientId ?? (await this.phonePatients())[0]?.id ?? null;
    await this.q.query(
      `insert into tasks (clinic_id, kind, priority, title, detail, call_id, patient_id, appointment_id, created_by, dedupe_key)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, 'voice', $8)
       on conflict (clinic_id, dedupe_key) do nothing`,
      [
        kind,
        priority,
        title,
        detail.slice(0, 1000),
        this.ctx.callId,
        patientId,
        extra.appointmentId ?? null,
        dedupe,
      ],
    );
  }

  private async phonePatients(): Promise<Patient[]> {
    return this.ctx.phone ? findPatientsByPhone(this.q, this.ctx.phone) : [];
  }

  private callerLabel(patients: Patient[]) {
    return patients[0]?.name ?? this.ctx.phone ?? "Unknown caller";
  }

  // ---------------------------------------------------------------- entry point

  async handle(ctx: VoiceContext, input: VoiceInput): Promise<VoiceTurn> {
    this.ctx = ctx;
    this.out = [];
    this.expectNext = "open";
    this.endAction = undefined;
    this.plan = false;
    this.emergency = false;
    this.s.turns++;

    if (this.s.turns > MAX_TURNS && input.kind !== "start") {
      this.say(this.t("too_long"), false);
      await this.transfer("staff", "Long call: the assistant handed over");
      return this.finish();
    }

    switch (input.kind) {
      case "start":
        if (ctx.purpose === "confirm_appointment" && ctx.subjectId) await this.outboundStart(ctx.subjectId);
        else {
          this.say(this.t("greeting"), false);
          this.ask(this.t("how_help"));
        }
        break;
      case "no_input":
        await this.silence();
        break;
      case "unclear":
        await this.miss();
        break;
      case "dtmf":
        await this.dtmf(input.digit);
        break;
      case "speech":
        this.s.silences = 0;
        await this.speech(input.text, input.language);
        break;
    }
    return this.finish();
  }

  private async finish(): Promise<VoiceTurn> {
    // Every sentence passes the same safety filter as WhatsApp before it can be spoken.
    const say: Utterance[] = [];
    for (const [i, u] of this.out.entries()) {
      const check = checkOutput(u.text);
      if (check.ok) {
        say.push(u);
        continue;
      }
      await this.task(
        "followup",
        "high",
        "Phone assistant reply blocked by safety filter",
        check.reasons.join(", "),
        `safety:${this.ctx.callId}:${this.s.turns}:${i}`,
      );
      say.push({ text: this.t("safe_fallback"), interruptible: false });
      if (!this.endAction) this.endAction = { kind: "hangup" };
      break;
    }
    return {
      say,
      expect: this.expectNext,
      end: this.endAction,
      planMessages: this.plan,
      emergency: this.emergency,
    };
  }

  private async silence() {
    this.s.silences++;
    if (this.s.silences >= 2) {
      this.say(this.t("no_input_bye"), false);
      this.s.outcome ??= "no_input";
      this.endAction = { kind: "hangup" };
      return;
    }
    this.say(this.t("still_there"));
    if (this.s.lastQuestion) this.ask(this.s.lastQuestion.text, this.s.lastQuestion.expect);
    else this.ask(this.t("how_help"));
  }

  private async miss() {
    this.s.misses++;
    if (this.s.misses >= 3) {
      await this.transfer("staff", "The assistant could not understand the caller");
      return;
    }
    if (this.s.misses === 2) {
      this.s.step = "offer_staff";
      this.say(this.t("not_understood"));
      this.ask(this.t("offer_staff"), "yes_no");
      return;
    }
    this.say(this.t("repeat"));
    if (this.s.lastQuestion) this.expectNext = this.s.lastQuestion.expect;
  }

  private async dtmf(digit: string) {
    if (digit === "0") return this.human("Pressed 0 for staff");
    const yesNo = [
      "confirm",
      "cancel_confirm",
      "who_confirm",
      "anything_else",
      "offer_book",
      "offer_consult",
      "offer_staff",
    ];
    if (this.s.step && yesNo.includes(this.s.step) && (digit === "1" || digit === "2"))
      return this.speech(digit === "1" ? "haan" : "nahi", null);
    if (
      (this.s.step === "slots" || this.s.step === "appt_pick" || this.s.step === "who") &&
      /^[123]$/.test(digit)
    )
      return this.speech(digit, null);
    return this.miss();
  }

  // ---------------------------------------------------------------- speech

  private switchLanguage(text: string, sttLanguage: string | null): boolean {
    const t = romanize(text).toLowerCase();
    if (/\b(english|angrezi|angreji)\b/.test(t) && this.s.lang !== "en") {
      this.s.lang = "en";
      this.say(this.t("switched_en"));
      return true;
    }
    if (/\b(hindi)\b/.test(t) && this.s.lang !== "hi") {
      this.s.lang = "hi";
      this.say(this.t("switched_hi"));
      return true;
    }
    if (this.s.step === "name") return false;
    // The words decide, not the speech engine's label: Hinglish often comes back tagged as English.
    const words = text.trim().split(/\s+/).length;
    const detected = detectLanguage(text);
    if ((detected === "hi" || detected === "hinglish") && words >= 2) this.s.lang = "hi";
    else if (detected === "en" && words >= 3 && !sttLanguage?.startsWith("hi")) this.s.lang = "en";
    return false;
  }

  private async speech(text: string, sttLanguage: string | null) {
    const trimmed = text.trim();
    if (!trimmed) return this.miss();
    const switched = this.switchLanguage(trimmed, sttLanguage);

    // 1. Emergencies first, always (Build Prompt §6.6).
    const emergency = detectEmergency(trimmed, this.facts.emergencyTriggers);
    if (emergency.level !== "none") return this.handleEmergency(trimmed, emergency.level, emergency.triggers);

    // 2. "Don't call me" is honoured at once (§6.9).
    if (
      /\b(call mat karo|call mat karna|call mat kijiye|phone mat karo|phone mat karna|don'?t call( me)?|do not call( me)?|stop calling|call band karo)\b/i.test(
        romanize(trimmed),
      )
    )
      return this.voiceOptOut();

    // Speaking after the recording notice counts as agreeing to it (docs/COMPLIANCE.md).
    if (!this.s.consented && this.ctx.phone) {
      await this.q.query(
        `insert into consents (clinic_id, phone, purpose, channel, granted, notice_version, language, captured_via)
         values (app.current_clinic_id(), $1, 'call_recording', 'voice', true, $2, $3, 'continued_after_notice')`,
        [this.ctx.phone, VOICE_NOTICE_VERSION, this.s.lang],
      );
      this.s.consented = true;
    }

    if (switched && trimmed.split(/\s+/).length <= 4) {
      if (this.s.lastQuestion) this.ask(this.s.lastQuestion.text, this.s.lastQuestion.expect);
      else this.ask(this.t("how_help"));
      return;
    }

    const u = await understand(trimmed, {
      today: this.today(),
      procedures: this.facts.procedures,
      llm: this.ctx.llm,
    });
    if (u.intent !== "other" && u.intent !== "yes" && u.intent !== "no" && !this.s.intents.includes(u.intent))
      this.s.intents.push(u.intent);
    if (switched && u.intent === "other") {
      // "Can we talk in English?" is only a language request: ask again in the new language.
      if (this.s.lastQuestion && this.s.step)
        return this.ask(this.s.lastQuestion.text, this.s.lastQuestion.expect);
      return this.ask(this.t("how_help"));
    }
    return this.byStep(trimmed, u);
  }

  private async byStep(text: string, u: Understanding) {
    const step = this.s.step;
    const changedSubject = [
      "medical",
      "cancel",
      "reschedule",
      "human",
      "timings",
      "location",
      "price",
      "check_appointment",
      "bot_question",
      "doctors",
    ].includes(u.intent);
    const yes = u.intent === "yes";
    const no = u.intent === "no";

    if (step === "name" && !changedSubject) return this.gotName(text);
    if (step === "reason" && !changedSubject) return this.gotReason(text, u);
    if (step === "price" && u.procedureId) return this.price(u.procedureId);
    if (step === "slots" && !changedSubject) return this.slotAnswer(text, u);
    if (step === "confirm" && (yes || no)) {
      if (no) return this.otherTime();
      return this.s.flow === "reschedule" ? this.confirmReschedule() : this.confirmBooking();
    }
    if (
      step === "confirm" &&
      !changedSubject &&
      (u.date || u.partsOfDay || parseClockPreference(text) !== null)
    )
      return this.slotAnswer(text, u);
    if (step === "cancel_confirm" && (yes || no)) {
      if (yes) return this.doCancel();
      this.resetFlow();
      this.say(this.t("kept"));
      return this.anythingElse();
    }
    if (step === "who_confirm" && (yes || no)) {
      if (yes) {
        this.s.patientId = this.s.candidatePatientId;
        return this.continueBooking();
      }
      this.s.step = "name";
      return this.ask(this.t("ask_name"), "name");
    }
    if (step === "who" && !changedSubject) return this.whoAnswer(text, u);
    if (step === "appt_pick" && u.choice) {
      const id = this.s.appointmentChoices?.[u.choice - 1];
      if (id) {
        this.s.appointmentId = id;
        return this.s.flow === "cancel" ? this.askCancel() : this.startReschedule();
      }
    }
    if ((step === "offer_book" || step === "offer_consult") && (yes || no)) {
      if (yes) return this.startBooking(null, step === "offer_consult" ? this.consultationId() : undefined);
      this.resetFlow();
      return this.anythingElse();
    }
    if (step === "outbound_confirm") {
      const t = ` ${romanize(text).toLowerCase()} `;
      const negative = /\b(nahi|nahin|nai|no|not|can'?t|cannot|won'?t|mushkil)\b/.test(t);
      const coming =
        /\b(aa (jaunga|jaungi|jayenge|jaenge|jaoonga|raha|rahi|rahe|sakta|sakti|sakenge|payenge|paunga|paungi)|aaunga|aaungi|aayenge|will come|i'?ll come|i will be there|coming|pakka|confirm)\b/.test(
          t,
        );
      if (yes || (coming && !negative)) return this.outboundConfirm();
      if (u.intent === "reschedule") return this.startReschedule();
      if (u.intent === "cancel") return this.askCancel();
      if (no) {
        this.s.step = "outbound_change";
        return this.ask(this.t("outbound_change_q"));
      }
    }
    if (step === "outbound_change") {
      const t = romanize(text).toLowerCase();
      if (u.intent === "reschedule" || /\b(badal|change|move|time|dusra|doosra|another)\b/.test(t))
        return this.startReschedule();
      if (u.intent === "cancel" || /\b(cancel|radd)\b/.test(t)) return this.askCancel();
      if (no || u.intent === "human") return this.outboundStaff();
    }
    if (step === "offer_staff" && (yes || no)) {
      if (yes) return this.human("Asked for staff after being misunderstood");
      this.s.misses = 0;
      this.resetFlow();
      return this.ask(this.t("how_help"));
    }
    if (step === "anything_else") {
      if (isDone(text) || no || u.intent === "thanks") return this.goodbye();
      if (yes) {
        this.s.step = undefined;
        return this.ask(this.t("ok_listening"));
      }
    }
    return this.intent(u, text);
  }

  private async intent(u: Understanding, text: string) {
    switch (u.intent) {
      case "book":
        return this.startBooking(u, undefined, text);
      case "reschedule":
        return this.pickAppointment("reschedule");
      case "cancel":
        return this.pickAppointment("cancel");
      case "check_appointment":
        return this.tellAppointments();
      case "timings":
        await this.timings();
        return this.anythingElse();
      case "location":
        this.say(
          this.facts.address ? this.t("address", { address: this.facts.address }) : this.t("address_unknown"),
        );
        this.s.outcome ??= "information";
        return this.anythingElse();
      case "price":
        if (u.procedureId) return this.price(u.procedureId);
        this.s.step = "price";
        return this.ask(this.t("price_which"));
      case "doctors":
        await this.doctors();
        return this.anythingElse();
      case "human":
        return this.human(text);
      case "medical":
        this.note("Asked for medical advice (not given)");
        this.s.step = "offer_consult";
        return this.ask(this.t("medical"), "yes_no");
      case "bot_question":
        this.say(this.t("bot_disclosure"));
        return this.ask(this.t("how_help"));
      case "greeting":
        return this.ask(this.t("ok_listening"));
      case "thanks":
        this.say(this.t("thanks_reply"));
        return this.anythingElse();
      case "stop":
        return this.goodbye();
      case "yes":
        if (!this.s.step) return this.ask(this.t("ok_listening"));
        return this.miss();
      case "no":
        if (!this.s.step) return this.goodbye();
        return this.miss();
      default:
        return this.miss();
    }
  }

  private goodbye() {
    this.say(this.t("goodbye"), false);
    this.s.outcome ??= "information";
    this.endAction = { kind: "hangup" };
  }

  // ---------------------------------------------------------------- outbound confirmation calls

  private async outboundStart(appointmentId: string) {
    const a = await this.ownAppointment(appointmentId);
    this.say(this.t("outbound_greeting"), false);
    if (!a || !["booked", "confirmed"].includes(a.status)) {
      this.say(this.t("goodbye"), false);
      this.endAction = { kind: "hangup" };
      return;
    }
    const doctor =
      (
        await this.q.query(
          "select d.name from appointments a join doctors d on d.id = a.doctor_id where a.id = $1",
          [a.id],
        )
      ).rows[0]?.name ?? "";
    this.s.appointmentId = a.id;
    this.s.patientId = a.patient_id;
    this.s.step = "outbound_confirm";
    // Answering the call and hearing the notice is the recording consent (as for incoming calls).
    this.ask(
      this.t("outbound_confirm_q", { patient: a.patient, when: this.when(a.starts_at), doctor }),
      "yes_no",
    );
  }

  private async outboundConfirm() {
    const a = this.s.appointmentId ? await this.ownAppointment(this.s.appointmentId) : undefined;
    if (a?.status === "booked") await setAppointmentStatus(this.q, a.id, "confirmed");
    this.note(`Confirmed ${a?.patient ?? "the"} appointment on an outbound call`);
    this.s.outcome = "confirmed";
    this.resetFlow();
    this.say(this.t("outbound_confirmed"), false);
    this.endAction = { kind: "hangup" };
  }

  private async outboundStaff() {
    await this.task(
      "callback",
      "normal",
      "Could not confirm the appointment on the call",
      "The patient wants to talk about their appointment.",
      `outbound:${this.ctx.callId}`,
      {
        appointmentId: this.s.appointmentId ?? null,
      },
    );
    this.s.outcome = "callback";
    this.resetFlow();
    this.say(this.t("outbound_staff_will_call"), false);
    this.endAction = { kind: "hangup" };
  }

  private async voiceOptOut() {
    if (this.ctx.phone)
      await this.q.query(
        `insert into opt_outs (clinic_id, phone, channel, category, source) values (app.current_clinic_id(), $1, 'voice', 'all', 'voice_request')
         on conflict do nothing`,
        [this.ctx.phone],
      );
    this.note("Asked not to be called again (recorded)");
    this.resetFlow();
    this.say(this.t("voice_optout"), false);
    this.s.outcome ??= "information";
    this.endAction = { kind: "hangup" };
  }

  // ---------------------------------------------------------------- emergencies and hand-over

  /** Doctors first (by emergency order), then staff phones, then the clinic's own number. */
  private async transferNumbers(kind: "staff" | "emergency"): Promise<string[]> {
    const numbers: string[] = [];
    if (kind === "emergency") {
      const { rows } = await this.q.query(
        "select phone from doctors where active and phone is not null and emergency_order is not null order by emergency_order",
      );
      numbers.push(...rows.map((r) => r.phone as string));
    }
    numbers.push(...this.facts.staffPhones);
    if (this.facts.phone) numbers.push(this.facts.phone);
    return [...new Set(numbers)].filter((n) => n !== this.ctx.phone);
  }

  private async transfer(kind: "staff" | "emergency", reason: string) {
    const numbers = await this.transferNumbers(kind);
    if (numbers.length === 0) {
      await this.task(
        kind === "emergency" ? "emergency" : "callback",
        kind === "emergency" ? "critical" : "high",
        `${kind === "emergency" ? "Emergency call" : "Call back"}: ${this.callerLabel(await this.phonePatients())}`,
        `${reason}. No number was set up to transfer the call to.`,
        `transfer:${this.ctx.callId}`,
      );
      this.say(this.t(kind === "emergency" ? "emergency_no_one" : "callback_promise"), false);
      this.s.outcome = kind === "emergency" ? "emergency" : "callback";
      this.endAction = { kind: "hangup" };
      return;
    }
    await this.q.query(
      "update calls set transfer_kind = $2, transfer_numbers = $3, status = 'transferring' where id = $1",
      [this.ctx.callId, kind, numbers],
    );
    await releaseHolds(this.q, `call:${this.ctx.callId}`);
    this.note(`${kind === "emergency" ? "Emergency transfer" : "Transferred to staff"}: ${reason}`);
    if (kind === "staff") this.s.outcome = "transferred";
    this.endAction = { kind: "transfer", to: kind };
  }

  private async human(text: string) {
    const numbers = await this.transferNumbers("staff");
    if (numbers.length) this.say(this.t("connecting_staff"), false);
    await this.transfer("staff", text.slice(0, 200));
  }

  private async handleEmergency(text: string, level: "urgent" | "life_threatening", triggers: string[]) {
    this.emergency = true;
    this.s.outcome = "emergency";
    const patients = await this.phonePatients();
    const who = this.callerLabel(patients);
    await this.task(
      "emergency",
      "critical",
      `Emergency call: ${who}`,
      `${describeEmergency(level, triggers)}\n\n"${text}"`,
      `emergency:${this.ctx.callId}`,
      { patientId: patients[0]?.id ?? null },
    );
    const doctors = (
      await this.q.query(
        "select id, phone from doctors where active and phone is not null and emergency_order is not null order by emergency_order limit 2",
      )
    ).rows;
    for (const d of doctors) {
      await enqueueMessage(this.q, {
        to: d.phone,
        category: "critical",
        purpose: "staff_emergency_alert",
        payload: {
          kind: "template",
          purpose: "staff_alert",
          language: "en",
          params: [
            level === "life_threatening" ? "LIFE-THREATENING" : "urgent",
            `${who} ${this.ctx.phone ?? ""} (phone call)`,
            `"${text.slice(0, 300)}"`,
          ],
        },
        dedupeKey: `call-emergency:${this.ctx.callId}:${d.id}`,
      });
    }
    this.resetFlow();
    const numbers = await this.transferNumbers("emergency");
    if (numbers.length)
      this.say(this.t(level === "life_threatening" ? "emergency_life" : "emergency_urgent"), false);
    else if (level === "life_threatening")
      this.say(
        this.t("emergency_life")
          .split(/(?<=[.।])\s/)
          .slice(0, 2)
          .join(" "),
        false,
      );
    await this.transfer("emergency", describeEmergency(level, triggers));
    this.s.outcome = "emergency";
  }

  // ---------------------------------------------------------------- booking

  private async startBooking(u: Understanding | null, procedureId?: string, text?: string) {
    const lang = this.s.lang;
    this.resetFlow();
    this.s.lang = lang;
    this.s.flow = "book";
    this.s.procedureId = procedureId ?? u?.procedureId ?? undefined;
    this.s.fromDate = u?.date?.fromDate;
    this.s.toDate = u?.date?.toDate;
    this.s.partsOfDay = u?.partsOfDay ?? null;
    this.s.relationship = u?.relationship ?? null;
    this.s.nearMinutes = text ? parseClockPreference(text) : null;
    const patients = await this.phonePatients();

    if (this.s.relationship) {
      const owner = patients[0];
      if (owner) {
        const { rows } = await this.q.query(
          `select p.id, p.name from patient_family_links l join patients p on p.id = l.related_patient_id
           where l.patient_id = $1 and l.relationship = $2 and p.deleted_at is null limit 1`,
          [owner.id, this.s.relationship],
        );
        if (rows[0]) {
          this.s.candidatePatientId = rows[0].id;
          this.s.step = "who_confirm";
          return this.ask(this.t("confirm_patient", { name: rows[0].name }), "yes_no");
        }
      }
      this.s.step = "name";
      return this.ask(
        this.t("ask_name_relation", { relation: spokenRelation(this.s.relationship, this.s.lang) }),
        "name",
      );
    }
    if (patients.length === 0) {
      this.s.step = "name";
      return this.ask(this.t("ask_name"), "name");
    }
    if (patients.length === 1) {
      this.s.candidatePatientId = patients[0]!.id;
      this.s.step = "who_confirm";
      return this.ask(this.t("confirm_patient", { name: patients[0]!.name }), "yes_no");
    }
    this.s.step = "who";
    this.s.familyChoices = patients.slice(0, 3).map((p) => ({ id: p.id, name: p.name }));
    return this.ask(
      this.t("ask_who", {
        names: spokenList(
          this.s.familyChoices.map((p) => p.name),
          this.s.lang,
        ),
      }),
    );
  }

  private async whoAnswer(text: string, u: Understanding) {
    const choices = this.s.familyChoices ?? [];
    const roman = romanize(text);
    if (/\b(someone else|koi aur|kisi aur|dusre|doosre ke liye|new|naya)\b/i.test(roman)) {
      this.s.step = "name";
      return this.ask(this.t("ask_name"), "name");
    }
    const byName = choices.find(
      (p) =>
        isLikelySamePerson(p.name, text) ||
        isLikelySamePerson(romanize(p.name), roman) ||
        text.includes(p.name),
    );
    const picked = byName ?? (u.choice ? choices[u.choice - 1] : undefined);
    if (picked) {
      this.s.patientId = picked.id;
      return this.continueBooking();
    }
    // A name we don't know: book for them as a new patient.
    return this.gotName(text);
  }

  private gotName(text: string) {
    const roman = romanize(text);
    const cleaned = (hasDevanagari(text) ? text : roman)
      .replace(
        /^(my name is|the name is|name is|it'?s|this is|mera naam|naam|name|patient( ka)? naam|uska naam|unka naam|मेरा नाम|नाम|उनका नाम|उसका नाम)\s*(hai|is|है)?\s*[:-]?\s*/i,
        "",
      )
      .replace(/\s+(hai|he|h|है|ji|जी)\s*[.!।]*$/i, "")
      .replace(/[^\p{L}\p{M}\s.'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (cleaned.length < 2) {
      this.s.misses++;
      return this.ask(this.t("ask_name_again"), "name");
    }
    this.s.newPatientName = cleaned.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
    return this.continueBooking();
  }

  private gotReason(text: string, u: Understanding) {
    this.s.procedureId =
      u.procedureId ?? matchProcedure(romanize(text), this.facts.procedures) ?? this.consultationId();
    if (!this.s.fromDate && u.date) {
      this.s.fromDate = u.date.fromDate;
      this.s.toDate = u.date.toDate;
    }
    this.s.partsOfDay = this.s.partsOfDay ?? u.partsOfDay;
    this.s.nearMinutes = this.s.nearMinutes ?? parseClockPreference(text);
    return this.offer({});
  }

  private async continueBooking() {
    if (!this.s.procedureId) {
      this.s.step = "reason";
      return this.ask(this.t("ask_reason"));
    }
    return this.offer({});
  }

  private async offer(
    change: {
      date?: { fromDate: string; toDate: string } | null;
      partsOfDay?: string[] | null;
      nearMinutes?: number | null;
      later?: boolean;
    },
    prefix?: VoiceCopyKey,
  ) {
    const procedureId = this.s.procedureId ?? this.consultationId();
    if (!procedureId) return this.human("No consultation procedure configured");
    const holder = `call:${this.ctx.callId}`;
    await releaseHolds(this.q, holder);
    if (prefix) this.say(this.t(prefix));

    if (change.date) {
      this.s.fromDate = change.date.fromDate;
      this.s.toDate = change.date.toDate;
    }
    if (change.partsOfDay) this.s.partsOfDay = change.partsOfDay;
    if (change.nearMinutes !== undefined && change.nearMinutes !== null)
      this.s.nearMinutes = change.nearMinutes;
    if (change.later) {
      const lastShown = this.s.options?.at(-1)?.start;
      this.s.fromDate = lastShown
        ? addDays(localDateOf(new Date(lastShown), this.facts.timezone), 1)
        : addDays(this.today(), 1);
      this.s.toDate = undefined;
    }

    const search = (from?: string, to?: string) =>
      offerSlots(this.q, {
        procedureId,
        fromDate: from,
        toDate: to ?? (from ? addDays(from, 6) : undefined),
        partsOfDay: (this.s.partsOfDay as PartOfDay[] | null) ?? undefined,
        nearMinutes: this.s.nearMinutes ?? undefined,
        now: this.ctx.now,
        count: 2,
        holder,
      });

    let holds: Hold[] = await search(this.s.fromDate, this.s.toDate);
    if (holds.length === 0 && this.s.fromDate) {
      this.say(this.t("no_slots_then"));
      holds = await search(addDays(this.s.toDate ?? this.s.fromDate, 1));
    }
    if (holds.length === 0) {
      await this.task(
        "callback",
        "high",
        "No free slot found on a phone call",
        this.procedureName(procedureId),
        `noslot:${this.ctx.callId}`,
      );
      this.resetFlow();
      this.say(this.t("no_slots_at_all"));
      this.s.outcome ??= "callback";
      return this.anythingElse();
    }
    this.s.procedureId = procedureId;
    this.s.options = holds.map((h) => ({
      holdId: h.holdId,
      start: h.start.toISOString(),
      end: h.end.toISOString(),
      doctorId: h.doctorId,
    }));
    const procedure = this.procedureName(procedureId);
    if (holds.length === 1) {
      this.s.chosenHoldId = holds[0]!.holdId;
      this.s.step = "slots";
      return this.ask(this.t("offer_one", { procedure, a: this.when(holds[0]!.start) }), "yes_no");
    }
    this.s.step = "slots";
    return this.ask(
      this.t("offer_two", { procedure, a: this.when(holds[0]!.start), b: this.when(holds[1]!.start) }),
      "choice",
    );
  }

  private async slotAnswer(text: string, u: Understanding) {
    const options = this.s.options ?? [];
    // "Haan" / "theek hai" to "A or B?" takes the first; the read-back that follows still asks for a clear yes.
    if ((u.intent === "yes" || (options.length === 1 && u.choice === 1)) && options[0])
      return this.chooseSlot(options[0].holdId);
    if (u.choice && options[u.choice - 1]) return this.chooseSlot(options[u.choice - 1]!.holdId);
    const minutes = parseClockPreference(text);
    if (minutes !== null) {
      const match = options.find(
        (o) =>
          localMinutesOf(new Date(o.start), this.facts.timezone) === minutes &&
          (!u.date || localDateOf(new Date(o.start), this.facts.timezone) === u.date.fromDate),
      );
      if (match) return this.chooseSlot(match.holdId);
    }
    if (u.date && !minutes) {
      const sameDay = options.filter(
        (o) => localDateOf(new Date(o.start), this.facts.timezone) === u.date!.fromDate,
      );
      if (sameDay.length === 1 && u.date.fromDate === u.date.toDate)
        return this.chooseSlot(sameDay[0]!.holdId);
    }
    if (u.date || u.partsOfDay || minutes !== null)
      return this.offer({ date: u.date, partsOfDay: u.partsOfDay, nearMinutes: minutes });
    if (
      u.intent === "no" ||
      /\b(koi aur|dusra din|doosra din|other|another|later|baad mein|agle)\b/i.test(romanize(text))
    )
      return this.offer({ later: true });
    this.s.misses++;
    if (this.s.misses >= 3) return this.human("Could not agree a time");
    return this.ask(this.t("pick_one"), "choice");
  }

  private async chooseSlot(holdId: string) {
    const option = this.s.options?.find((o) => o.holdId === holdId);
    if (!option) return this.offer({}, "slot_gone");
    this.s.chosenHoldId = holdId;
    this.s.step = "confirm";
    const doctor =
      (await this.q.query("select name from doctors where id = $1", [option.doctorId])).rows[0]?.name ?? "";
    const patient = await this.patientName();
    const key: VoiceCopyKey = this.s.flow === "reschedule" ? "readback_reschedule" : "readback";
    return this.ask(this.t(key, { patient, when: this.when(option.start), doctor }), "yes_no");
  }

  private otherTime() {
    this.s.step = "slots";
    return this.ask(this.t("other_time"), "open");
  }

  private async patientName(): Promise<string> {
    const id = this.s.patientId;
    if (id) return (await this.q.query("select name from patients where id = $1", [id])).rows[0]?.name ?? "";
    if (this.s.appointmentId) {
      const { rows } = await this.q.query(
        "select p.name from appointments a join patients p on p.id = a.patient_id where a.id = $1",
        [this.s.appointmentId],
      );
      return rows[0]?.name ?? "";
    }
    return this.s.newPatientName ?? "";
  }

  private async confirmBooking() {
    const holdId = this.s.chosenHoldId;
    if (!holdId) return this.ask(this.t("how_help"));
    let patientId = this.s.patientId;
    if (!patientId) {
      const created = await createPatient(this.q, {
        name: this.s.newPatientName ?? "Phone patient",
        phone: this.ctx.phone,
        source: "voice",
      });
      patientId = created.id;
      if (this.s.relationship) {
        const owner = (await this.phonePatients()).find((p) => p.id !== patientId);
        if (owner)
          await linkFamily(this.q, {
            patientId: owner.id,
            relatedPatientId: patientId,
            relationship: this.s.relationship,
          });
      }
    }
    try {
      const appointment = await bookFromHold(this.q, {
        holdId,
        patientId,
        source: "voice",
        idempotencyKey: `voice:${this.ctx.callId}:${holdId}`,
      });
      await this.q.query(
        "update calls set patient_id = coalesce(patient_id, $2), appointment_id = $3 where id = $1",
        [this.ctx.callId, patientId, appointment.id],
      );
      const when = this.when(appointment.startsAt);
      this.note(
        `Booked ${await this.nameOf(patientId)} for ${spokenWhen(appointment.startsAt, this.facts.timezone, "en", this.ctx.now)} (${this.procedureNameEn(appointment.procedureTypeId)})`,
      );
      this.s.outcome = "booked";
      this.s.bookedAppointmentId = appointment.id;
      this.plan = true;
      this.resetFlow();
      this.say(this.t("booked", { when }));
      return this.anythingElse();
    } catch (error) {
      if (error instanceof DomainError && (error.code === "slot_taken" || error.code === "hold_not_found")) {
        this.s.patientId = patientId;
        return this.offer({}, "slot_gone");
      }
      throw error;
    }
  }

  private procedureNameEn(id: string | null | undefined) {
    return this.facts.procedures.find((p) => p.id === id)?.name ?? "visit";
  }

  private async nameOf(patientId: string) {
    return (await this.q.query("select name from patients where id = $1", [patientId])).rows[0]?.name ?? "";
  }

  // ---------------------------------------------------------------- existing appointments

  private async upcoming() {
    if (!this.ctx.phone) return [];
    const { rows } = await this.q.query(
      `select a.id, a.starts_at, a.status, a.procedure_type_id, a.patient_id, p.name as patient, d.name as doctor
       from appointments a join patients p on p.id = a.patient_id join doctors d on d.id = a.doctor_id
       where (p.phone = $1 or p.alt_phone = $1) and p.deleted_at is null and a.status in ('booked', 'confirmed')
         and a.starts_at > $2
       order by a.starts_at limit 3`,
      [this.ctx.phone, this.ctx.now],
    );
    return rows as {
      id: string;
      starts_at: Date;
      status: string;
      procedure_type_id: string | null;
      patient_id: string;
      patient: string;
      doctor: string;
    }[];
  }

  private async tellAppointments() {
    const list = await this.upcoming();
    this.s.outcome ??= "information";
    if (list.length === 0) {
      this.s.step = "offer_book";
      return this.ask(this.t("no_upcoming"), "yes_no");
    }
    for (const a of list.slice(0, 2))
      this.say(this.t("your_appointment", { when: this.when(a.starts_at), doctor: a.doctor }));
    return this.anythingElse();
  }

  private async pickAppointment(flow: "reschedule" | "cancel") {
    const list = await this.upcoming();
    const lang = this.s.lang;
    this.resetFlow();
    this.s.lang = lang;
    this.s.flow = flow;
    if (list.length === 0) {
      this.s.step = "offer_book";
      return this.ask(this.t("no_upcoming"), "yes_no");
    }
    if (list.length === 1) {
      this.s.appointmentId = list[0]!.id;
      return flow === "cancel" ? this.askCancel() : this.startReschedule();
    }
    this.s.step = "appt_pick";
    this.s.appointmentChoices = list.slice(0, 2).map((a) => a.id);
    return this.ask(
      this.t("which_appointment", {
        count: String(Math.min(list.length, 2)),
        a: `${list[0]!.patient}, ${this.when(list[0]!.starts_at)}`,
        b: `${list[1]!.patient}, ${this.when(list[1]!.starts_at)}`,
      }),
      "choice",
    );
  }

  /** The appointment must belong to someone using the calling number (Build Prompt §6.7). */
  private async ownAppointment(id: string) {
    if (!this.ctx.phone) return undefined;
    const { rows } = await this.q.query(
      `select a.id, a.starts_at, a.status, a.procedure_type_id, a.patient_id, p.name as patient
       from appointments a join patients p on p.id = a.patient_id
       where a.id = $1 and (p.phone = $2 or p.alt_phone = $2)`,
      [id, this.ctx.phone],
    );
    return rows[0] as
      | {
          id: string;
          starts_at: Date;
          status: string;
          procedure_type_id: string | null;
          patient_id: string;
          patient: string;
        }
      | undefined;
  }

  private async askCancel() {
    const a = this.s.appointmentId ? await this.ownAppointment(this.s.appointmentId) : undefined;
    if (!a) return this.tellAppointments();
    this.s.flow = "cancel";
    this.s.step = "cancel_confirm";
    return this.ask(this.t("confirm_cancel", { patient: a.patient, when: this.when(a.starts_at) }), "yes_no");
  }

  private async doCancel() {
    const a = this.s.appointmentId ? await this.ownAppointment(this.s.appointmentId) : undefined;
    if (!a) return this.ask(this.t("how_help"));
    await cancelAppointment(this.q, a.id, "Cancelled by patient on a phone call");
    this.note(
      `Cancelled ${a.patient}'s appointment on ${spokenWhen(a.starts_at, this.facts.timezone, "en", this.ctx.now)}`,
    );
    this.s.outcome = "cancelled";
    this.plan = true;
    this.resetFlow();
    this.s.step = "offer_book";
    return this.ask(this.t("cancelled"), "yes_no");
  }

  private async startReschedule() {
    const a = this.s.appointmentId ? await this.ownAppointment(this.s.appointmentId) : undefined;
    if (!a) return this.tellAppointments();
    this.s.flow = "reschedule";
    this.s.patientId = a.patient_id;
    this.s.procedureId = a.procedure_type_id ?? this.consultationId();
    return this.otherTime();
  }

  private async confirmReschedule() {
    const option = this.s.options?.find((o) => o.holdId === this.s.chosenHoldId);
    const a = this.s.appointmentId ? await this.ownAppointment(this.s.appointmentId) : undefined;
    if (!option || !a) return this.ask(this.t("how_help"));
    const { rows } = await this.q.query(
      "delete from slot_holds where id = $1 returning doctor_id, chair_id, starts_at, ends_at",
      [option.holdId],
    );
    const hold = rows[0] ?? {
      doctor_id: option.doctorId,
      chair_id: undefined,
      starts_at: new Date(option.start),
      ends_at: new Date(option.end),
    };
    try {
      const { appointment } = await moveAppointment(this.q, a.id, {
        startsAt: hold.starts_at,
        endsAt: hold.ends_at,
        doctorId: hold.doctor_id,
        chairId: hold.chair_id,
        now: this.ctx.now,
      });
      await releaseHolds(this.q, `call:${this.ctx.callId}`);
      await this.q.query("update calls set appointment_id = $2 where id = $1", [this.ctx.callId, a.id]);
      this.note(
        `Moved ${a.patient}'s appointment to ${spokenWhen(appointment.startsAt, this.facts.timezone, "en", this.ctx.now)}`,
      );
      this.s.outcome = "rescheduled";
      this.plan = true;
      this.resetFlow();
      this.say(this.t("rescheduled", { when: this.when(appointment.startsAt) }));
      return this.anythingElse();
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === "slot_taken" || error.code === "needs_confirmation")
      )
        return this.offer({}, "slot_gone");
      throw error;
    }
  }

  /** "Confirm" from an outbound reminder call (Phase 4 uses this entry point). */
  async confirmAttendance(ctx: VoiceContext, appointmentId: string) {
    this.ctx = ctx;
    const a = await this.ownAppointment(appointmentId);
    if (!a) return;
    if (a.status === "booked") await setAppointmentStatus(this.q, a.id, "confirmed");
    this.s.outcome = "confirmed";
    this.say(this.t("confirmed_attendance", { when: this.when(a.starts_at) }));
  }

  // ---------------------------------------------------------------- information

  private async timings() {
    const { rows } = await this.q.query(
      "select weekday, extract(hour from start_time)::int * 60 + extract(minute from start_time)::int as s, extract(hour from end_time)::int * 60 + extract(minute from end_time)::int as e from working_hours where doctor_id is null order by weekday, start_time",
    );
    const lang = this.s.lang;
    const days = lang === "hi" ? HI_DAYS : EN_DAYS;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hoursOf = (d: number) =>
      rows
        .filter((r) => r.weekday === d)
        .map((r) =>
          lang === "hi"
            ? `${spokenClock(r.s, "hi")} से ${spokenClock(r.e, "hi")} तक`
            : `${spokenClock(r.s, "en")} to ${spokenClock(r.e, "en")}`,
        )
        .join(lang === "hi" ? " और " : " and ");
    const groups: string[] = [];
    const closed: string[] = [];
    for (let i = 0; i < order.length;) {
      const hours = hoursOf(order[i]!);
      let j = i;
      while (j + 1 < order.length && hoursOf(order[j + 1]!) === hours) j++;
      const span =
        i === j
          ? days[order[i]!]!
          : lang === "hi"
            ? `${days[order[i]!]} से ${days[order[j]!]}`
            : `${days[order[i]!]} to ${days[order[j]!]}`;
      if (hours) groups.push(`${span}, ${hours}`);
      else closed.push(span);
      i = j + 1;
    }
    this.say(this.t("timings", { hours: groups.join("; ") }));
    if (closed.length) this.say(this.t("closed_on", { days: spokenList(closed, lang) }));
    const holidays = (
      await this.q.query("select date from holidays where date between $1 and $2 order by date limit 2", [
        this.today(),
        addDays(this.today(), 14),
      ])
    ).rows;
    if (holidays.length) {
      const list = holidays.map((h) => {
        const iso = typeof h.date === "string" ? h.date : localDateOf(h.date, "UTC");
        return this.when(new Date(`${iso}T12:00:00+05:30`)).replace(/,?\s*(at )?[^,]*$/, "");
      });
      this.say(this.t("holiday", { list: spokenList(list, lang) }));
    }
    this.s.outcome ??= "information";
  }

  private price(procedureId: string) {
    const p = this.facts.procedures.find((x) => x.id === procedureId);
    this.s.outcome ??= "information";
    // Only prices the clinic entered and approved for patients (Build Prompt §6.4).
    if (!p || !p.pricePublic || p.priceMin === null || p.priceMax === null) {
      this.s.step = "offer_consult";
      return this.ask(this.t("price_unknown"), "yes_no");
    }
    this.s.step = undefined;
    this.say(
      this.t("price_range", {
        procedure: this.procedureName(p.id),
        min: spokenRupees(p.priceMin),
        max: spokenRupees(p.priceMax),
      }),
    );
    this.s.step = "offer_consult";
    return this.ask(
      this.t("price_unknown")
        .split(/(?<=[.।])\s/)
        .pop()!,
      "yes_no",
    );
  }

  private async doctors() {
    const { rows } = await this.q.query(
      "select name from doctors where active and kind <> 'on_call' order by kind, name limit 5",
    );
    this.say(
      this.t("doctors", {
        list: spokenList(
          rows.map((r) => r.name as string),
          this.s.lang,
        ),
      }),
    );
    this.s.outcome ??= "information";
  }
}

/** A short, factual summary for the calls list (written by code from what happened). */
export function summarizeCall(state: VoiceState): string {
  const parts = [...state.notes];
  if (parts.length === 0 && state.intents.length) parts.push(`Asked about: ${state.intents.join(", ")}`);
  return parts.join(". ") || "No request made";
}

import type { LLMProvider } from "@dentalos/adapters";
import {
  addDays,
  bookFromHold,
  buttonLabel,
  cancelAppointment,
  createPatient,
  DomainError,
  enqueueMessage,
  findPatientsByPhone,
  linkFamily,
  localDateOf,
  moveAppointment,
  offerSlots,
  releaseHolds,
  saveConversationState,
  setAppointmentStatus,
  whenInWords,
  type Conversation,
  type Hold,
  type Lang,
  type Patient,
} from "@dentalos/core";
import type { PoolClient } from "pg";
import { detectEmergency } from "../safety/emergency";
import { checkOutput } from "../safety/output-filter";
import { detectLanguage } from "../nlu/language";
import { matchProcedure, understand, type ProcedureOption, type Understanding } from "../nlu/intents";
import { relationWord, say, type CopyKey } from "./copy";

/**
 * The WhatsApp assistant (Build Prompt §5.2, §6). A state machine over the conversation: code decides every
 * step and writes every reply; the language model is only consulted to understand unclear messages.
 * Runs inside one clinic-scoped transaction, so replies (queued in the outbox) are only sent if the
 * bookings and changes they describe were committed (Build Prompt §3.1).
 */

export const CONSENT_NOTICE_VERSION = "wa-v1";

export type AssistantInput =
  | { kind: "text"; text: string }
  | { kind: "button"; payload: string; title: string }
  | { kind: "media"; mediaKind: "image" | "document" }
  | { kind: "voice_failed" };

interface HeldOption {
  holdId: string;
  start: string;
  end: string;
  doctorId: string;
}

export interface AssistantState {
  lang?: Lang;
  step?:
    "consent" | "who" | "name" | "reason" | "slots" | "confirm" | "appt_pick" | "cancel_confirm" | "price";
  flow?: "book" | "reschedule" | "cancel";
  pendingText?: string;
  patientId?: string;
  newPatientName?: string;
  relationship?: string | null;
  procedureId?: string;
  fromDate?: string;
  toDate?: string;
  partsOfDay?: string[] | null;
  options?: HeldOption[];
  chosenHoldId?: string;
  appointmentId?: string;
  appointmentChoices?: string[];
  familyChoices?: string[];
}

export interface AssistantContext {
  client: PoolClient;
  conversation: Conversation;
  inboundMessageId: string;
  llm?: LLMProvider;
  now: Date;
}

interface Reply {
  text: string;
  buttons?: { id: string; title: string }[];
}

interface ClinicInfo {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  mapsUrl: string | null;
  defaultLanguage: string;
  emergencyTriggers: string[];
}

const upcomingStatuses = ["booked", "confirmed"];

export interface AssistantOutcome {
  outboxIds: string[];
  emergency: boolean;
  replies: Reply[];
}

export async function runAssistant(ctx: AssistantContext, input: AssistantInput): Promise<AssistantOutcome> {
  const a = await Assistant.create(ctx);
  await a.handle(input);
  return a.finish();
}

class Assistant {
  private replies: Reply[] = [];
  private emergency = false;
  private state: AssistantState;

  private constructor(
    private readonly ctx: AssistantContext,
    private readonly clinic: ClinicInfo,
    private readonly procedures: (ProcedureOption & {
      name: string;
      nameHi: string | null;
      priceMin: number | null;
      priceMax: number | null;
      pricePublic: boolean;
      isConsultation: boolean;
    })[],
  ) {
    this.state = { ...(ctx.conversation.state as AssistantState) };
  }

  static async create(ctx: AssistantContext): Promise<Assistant> {
    const c = (
      await ctx.client.query(
        "select id, name, timezone, address, maps_url, default_language, settings from clinics where id = app.current_clinic_id()",
      )
    ).rows[0];
    const procs = (
      await ctx.client.query(
        "select id, code, name, name_hi, synonyms, price_min_paise, price_max_paise, price_public, is_consultation from procedure_types where active order by sort_order",
      )
    ).rows;
    return new Assistant(
      ctx,
      {
        id: c.id,
        name: c.name,
        timezone: c.timezone,
        address: c.address,
        mapsUrl: c.maps_url,
        defaultLanguage: c.default_language,
        emergencyTriggers: c.settings?.emergency?.extraTriggers ?? [],
      },
      procs.map((p) => ({
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
    );
  }

  // ---------------------------------------------------------------- helpers

  private get lang(): Lang {
    return this.state.lang ?? (this.clinic.defaultLanguage === "en" ? "en" : "hinglish");
  }

  private get q() {
    return this.ctx.client;
  }

  private t(key: CopyKey, params: Record<string, string> = {}) {
    return say(this.lang, key, { clinic: this.clinic.name, ...params });
  }

  private reply(text: string, buttons?: { id: string; title: string }[]) {
    this.replies.push({ text, buttons: buttons?.slice(0, 3) });
  }

  private when(iso: string | Date) {
    return whenInWords(new Date(iso), this.clinic.timezone, this.lang);
  }

  private today() {
    return localDateOf(this.ctx.now, this.clinic.timezone);
  }

  private procedureName(id: string | null | undefined) {
    const p = this.procedures.find((x) => x.id === id);
    if (!p) return "";
    return this.lang === "hi" && p.nameHi ? p.nameHi : p.name;
  }

  private consultationId(): string | undefined {
    return (
      this.procedures.find((p) => p.code === "consultation") ?? this.procedures.find((p) => p.isConsultation)
    )?.id;
  }

  private resetFlow() {
    const lang = this.state.lang;
    this.state = { lang };
  }

  private async task(
    kind: string,
    priority: string,
    title: string,
    detail: string,
    dedupe: string,
    extra: { patientId?: string | null; appointmentId?: string | null } = {},
  ) {
    await this.q.query(
      `insert into tasks (clinic_id, kind, priority, title, detail, conversation_id, patient_id, appointment_id, created_by, dedupe_key)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, 'bot', $8)
       on conflict (clinic_id, dedupe_key) do nothing`,
      [
        kind,
        priority,
        title,
        detail.slice(0, 1000),
        this.ctx.conversation.id,
        extra.patientId ?? this.ctx.conversation.patientId,
        extra.appointmentId ?? null,
        dedupe,
      ],
    );
  }

  private async phonePatients(): Promise<Patient[]> {
    return findPatientsByPhone(this.q, this.ctx.conversation.phone);
  }

  // ---------------------------------------------------------------- entry point

  async handle(input: AssistantInput) {
    const text = input.kind === "text" ? input.text.trim() : "";
    // Switch language only on real sentences: a bare name or "ok" should not flip Hinglish to English.
    const sentence = /[\u0900-\u097F]/.test(text) || text.split(/\s+/).length >= 3;
    if (text && this.state.step !== "name" && (sentence || !this.state.lang))
      this.state.lang = detectLanguage(text) ?? this.state.lang;

    // 1. Emergencies first, always (Build Prompt §6.6) — even before consent, even in human mode.
    if (text) {
      const emergency = detectEmergency(text, this.clinic.emergencyTriggers);
      if (emergency.level !== "none") return this.handleEmergency(text, emergency.level, emergency.triggers);
    }

    // Staff took over this thread: the assistant stays silent (Build Prompt §5.2).
    if (this.ctx.conversation.mode === "human") return;

    // 2. STOP / START work at any point.
    if (
      text &&
      /^\s*(stop|unsubscribe|band karo|message (mat|na) bhejo|mat bhejo|रोकें|बंद करें|बंद करो)\s*[.!]*\s*$/i.test(
        text,
      )
    )
      return this.stop();
    if (text && /^\s*(start|resume|shuru|शुरू)\s*[.!]*\s*$/i.test(text)) return this.start();

    // 3. Buttons on our own reminders act on the patient's appointment directly.
    if (input.kind === "button" && /^(confirm|reschedule|cancel):/.test(input.payload))
      return this.reminderButton(input.payload);

    // 4. Consent notice at first contact (Build Prompt §7.1).
    if (!(await this.hasConsent())) {
      const proceed = await this.consentGate(input);
      if (!proceed) return;
      if (proceed === "pending") {
        const pending = this.state.pendingText;
        this.state.pendingText = undefined;
        if (!pending) return this.welcome();
        return this.handleText(pending);
      }
    }

    if (input.kind === "voice_failed") return this.reply(this.t("voice_failed"));
    if (input.kind === "media") {
      await this.task(
        "followup",
        "normal",
        "Patient sent a file on WhatsApp",
        `A ${input.mediaKind} was sent.`,
        `media:${this.ctx.inboundMessageId}`,
      );
      return this.reply(this.t("media_received"));
    }
    if (input.kind === "button") return this.button(input.payload);
    return this.handleText(text);
  }

  finish(): Promise<AssistantOutcome> {
    return (async () => {
      await saveConversationState(this.q, this.ctx.conversation.id, this.state as Record<string, unknown>);
      const outboxIds: string[] = [];
      for (const [i, r] of this.replies.entries()) {
        let body = r.text;
        let buttons = r.buttons;
        const check = checkOutput([body, ...(buttons ?? []).map((b) => b.title)].join("\n"));
        if (!check.ok) {
          // Never send it; tell the patient the team will reply, and flag it for review.
          await this.task(
            "followup",
            "high",
            "Assistant reply blocked by safety filter",
            check.reasons.join(", "),
            `safety:${this.ctx.inboundMessageId}:${i}`,
          );
          body = this.t("safe_fallback");
          buttons = undefined;
        }
        const id = await enqueueMessage(this.q, {
          to: this.ctx.conversation.phone,
          category: this.emergency ? "critical" : "service",
          purpose: "assistant_reply",
          payload: buttons?.length
            ? { kind: "buttons", body: body.slice(0, 1024), buttons }
            : { kind: "text", text: body },
          dedupeKey: `reply:${this.ctx.inboundMessageId}:${i}`,
          patientId: this.ctx.conversation.patientId,
        });
        if (id) outboxIds.push(id);
      }
      return { outboxIds, emergency: this.emergency, replies: this.replies };
    })();
  }

  // ---------------------------------------------------------------- consent

  private async hasConsent(): Promise<boolean> {
    const { rows } = await this.q.query(
      "select granted from consents where phone = $1 and purpose = 'data_processing' order by at desc limit 1",
      [this.ctx.conversation.phone],
    );
    return rows[0]?.granted === true;
  }

  private async recordConsent(granted: boolean, via: string) {
    await this.q.query(
      `insert into consents (clinic_id, phone, patient_id, purpose, channel, granted, notice_version, language, captured_via, evidence_message_id)
       values (app.current_clinic_id(), $1, $2, 'data_processing', 'whatsapp', $3, $4, $5, $6, $7)`,
      [
        this.ctx.conversation.phone,
        this.ctx.conversation.patientId,
        granted,
        CONSENT_NOTICE_VERSION,
        this.lang,
        via,
        this.ctx.inboundMessageId,
      ],
    );
  }

  /** Returns "pending" to continue with the stored first message, true to continue, false to stop here. */
  private async consentGate(input: AssistantInput): Promise<"pending" | boolean> {
    if (this.state.step !== "consent") {
      this.state.step = "consent";
      if (input.kind === "text") this.state.pendingText = input.text;
      this.reply(this.t("consent_notice"), [{ id: "agree", title: this.t("btn_agree") }]);
      return false;
    }
    if (input.kind === "button" && input.payload === "agree") {
      await this.recordConsent(true, "whatsapp_agree_button");
      this.state.step = undefined;
      return "pending";
    }
    if (input.kind === "text" && /^\s*(no|nahi|nahin|na|नहीं)\s*[.!]*\s*$/i.test(input.text)) {
      await this.task(
        "callback",
        "normal",
        "Patient did not agree to the WhatsApp notice",
        "Please help them by phone.",
        `consent_declined:${this.ctx.conversation.id}`,
      );
      this.state.step = undefined;
      this.reply(this.t("human_ack"));
      return false;
    }
    // Writing again after reading the notice is a clear affirmative act (see docs/COMPLIANCE.md).
    await this.recordConsent(true, "whatsapp_continued_after_notice");
    this.state.step = undefined;
    this.state.pendingText = undefined;
    return true;
  }

  // ---------------------------------------------------------------- emergency, stop

  private async handleEmergency(text: string, level: "urgent" | "life_threatening", triggers: string[]) {
    this.emergency = true;
    const patients = await this.phonePatients();
    const who = patients[0]?.name ?? "Unknown caller";
    await this.task(
      "emergency",
      "critical",
      `Emergency on WhatsApp: ${who}`,
      `${triggers.join(", ")}\n\n"${text}"`,
      `emergency:${this.ctx.inboundMessageId}`,
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
            `${who} ${this.ctx.conversation.phone}`,
            `"${text.slice(0, 300)}"`,
          ],
        },
        dedupeKey: `emergency:${this.ctx.inboundMessageId}:${d.id}`,
      });
    }
    if (this.ctx.conversation.mode === "human") return;
    this.resetFlow();
    this.reply(this.t(level === "life_threatening" ? "emergency_life" : "emergency_urgent"));
  }

  private async stop() {
    await this.q.query(
      `insert into opt_outs (clinic_id, phone, channel, category, source) values (app.current_clinic_id(), $1, 'whatsapp', 'all', 'whatsapp_stop')
       on conflict do nothing`,
      [this.ctx.conversation.phone],
    );
    this.resetFlow();
    this.reply(this.t("stopped"));
  }

  private async start() {
    await this.q.query(
      "update opt_outs set revoked_at = now() where phone = $1 and channel in ('whatsapp', 'all') and revoked_at is null",
      [this.ctx.conversation.phone],
    );
    this.reply(this.t("started"));
  }

  // ---------------------------------------------------------------- text and buttons

  private async handleText(text: string) {
    const step = this.state.step;
    // Steps that expect a free-text answer, unless the patient clearly changed the subject.
    const u = await understand(text, { today: this.today(), procedures: this.procedures, llm: this.ctx.llm });
    const changedSubject = [
      "cancel",
      "reschedule",
      "human",
      "timings",
      "location",
      "price",
      "check_appointment",
      "bot_question",
    ].includes(u.intent);

    if (step === "name" && !changedSubject) return this.gotName(text);
    if (step === "reason" && !changedSubject) return this.gotReason(text, u);
    if (step === "price" && u.procedureId) return this.price(u.procedureId);
    if (step === "slots" && !changedSubject) {
      if (u.choice && this.state.options?.[u.choice - 1])
        return this.chooseSlot(this.state.options[u.choice - 1]!.holdId);
      if (u.date || u.partsOfDay) return this.offer({ date: u.date, partsOfDay: u.partsOfDay });
      if (u.intent === "no") return this.offer({ later: true });
      return this.reply(this.t("pick_from_buttons"));
    }
    if (step === "confirm" && (u.intent === "yes" || u.intent === "no"))
      return this.button(u.intent === "yes" ? "yes_book" : "other_time");
    if (step === "cancel_confirm" && (u.intent === "yes" || u.intent === "no"))
      return this.button(u.intent === "yes" ? "cancel_yes" : "keep");
    if ((step === "who" || step === "appt_pick") && u.choice) {
      const list = step === "who" ? this.state.familyChoices : this.state.appointmentChoices;
      const picked = list?.[u.choice - 1];
      if (picked) return this.button(step === "who" ? `who:${picked}` : `appt:${picked}`);
    }
    return this.intent(u, text);
  }

  private async intent(u: Understanding, text: string) {
    switch (u.intent) {
      case "book":
        return this.startBooking(u);
      case "reschedule":
        return this.pickAppointment("reschedule");
      case "cancel":
        return this.pickAppointment("cancel");
      case "check_appointment":
        return this.listAppointments();
      case "timings":
        return this.timings();
      case "location":
        return this.location();
      case "price":
        if (u.procedureId) return this.price(u.procedureId);
        this.state.step = "price";
        return this.reply(this.t("price_which"));
      case "doctors":
        return this.doctors();
      case "human":
        return this.human(text);
      case "bot_question":
        return this.reply(this.t("bot_disclosure"), [{ id: "staff", title: this.t("btn_staff") }]);
      case "greeting":
        return this.welcome();
      case "thanks":
        return this.reply(this.t("thanks_reply"));
      case "yes":
      case "no":
      case "other":
      default:
        await this.task(
          "followup",
          "normal",
          "WhatsApp message needs a reply",
          text,
          `unknown:${this.ctx.conversation.id}:${this.today()}`,
        );
        return this.reply(this.t("unknown"), [
          { id: "book", title: this.t("btn_book") },
          { id: "info", title: this.t("btn_info") },
          { id: "staff", title: this.t("btn_staff") },
        ]);
    }
  }

  private async button(payload: string) {
    const [kind, arg] = payload.split(/:(.*)/s) as [string, string | undefined];
    switch (kind) {
      case "agree":
        return this.welcome();
      case "book":
        return this.startBooking(null);
      case "consult":
        return this.startBooking(null, this.consultationId());
      case "info":
        await this.timings();
        return this.location();
      case "staff":
        return this.human("Asked to talk to staff");
      case "who":
        if (arg === "new") {
          this.state.step = "name";
          return this.reply(this.t("ask_name"));
        }
        this.state.patientId = arg;
        return this.continueBooking();
      case "slot":
        return this.chooseSlot(arg ?? "");
      case "more":
        return this.offer({ later: true });
      case "yes_book":
        return this.state.flow === "reschedule" ? this.confirmReschedule() : this.confirmBooking();
      case "other_time":
        return this.offer({ later: true });
      case "appt":
        this.state.appointmentId = arg;
        return this.state.flow === "cancel" ? this.askCancel() : this.startReschedule();
      case "cancel_yes":
        return this.doCancel();
      case "keep":
        this.resetFlow();
        return this.reply(this.t("kept"));
      default:
        return this.welcome();
    }
  }

  private welcome() {
    this.resetFlow();
    this.reply(this.t("welcome"), [
      { id: "book", title: this.t("btn_book") },
      { id: "info", title: this.t("btn_info") },
      { id: "staff", title: this.t("btn_staff") },
    ]);
  }

  private async human(text: string) {
    const patients = await this.phonePatients();
    await this.task(
      "callback",
      "high",
      `Wants to talk to staff: ${patients[0]?.name ?? this.ctx.conversation.phone}`,
      text,
      `human:${this.ctx.conversation.id}:${this.today()}`,
    );
    this.reply(this.t("human_ack"));
  }

  // ---------------------------------------------------------------- booking

  private async startBooking(u: Understanding | null, procedureId?: string) {
    const lang = this.state.lang;
    this.state = {
      lang,
      flow: "book",
      procedureId: procedureId ?? u?.procedureId ?? undefined,
      fromDate: u?.date?.fromDate,
      toDate: u?.date?.toDate,
      partsOfDay: u?.partsOfDay ?? null,
      relationship: u?.relationship ?? null,
    };
    const patients = await this.phonePatients();
    if (this.state.relationship) {
      // Booking for a family member: use the linked relative if we know them, else ask their name.
      const owner = patients[0];
      if (owner) {
        const { rows } = await this.q.query(
          `select p.id from patient_family_links l join patients p on p.id = l.related_patient_id
           where l.patient_id = $1 and l.relationship = $2 and p.deleted_at is null limit 1`,
          [owner.id, this.state.relationship],
        );
        if (rows[0]) {
          this.state.patientId = rows[0].id;
          return this.continueBooking();
        }
      }
      this.state.step = "name";
      return this.reply(
        this.t("ask_name_relation", { relation: relationWord(this.state.relationship, this.lang) }),
      );
    }
    if (patients.length === 0) {
      this.state.step = "name";
      return this.reply(this.t("ask_name"));
    }
    if (patients.length === 1) {
      this.state.patientId = patients[0]!.id;
      return this.continueBooking();
    }
    this.state.step = "who";
    this.state.familyChoices = patients.slice(0, 2).map((p) => p.id);
    return this.reply(this.t("ask_who"), [
      ...patients.slice(0, 2).map((p) => ({ id: `who:${p.id}`, title: p.name.slice(0, 20) })),
      { id: "who:new", title: this.t("btn_someone_else") },
    ]);
  }

  private gotName(text: string) {
    const name = text
      .replace(
        /^(my name is|mera naam|naam|name|patient( ka)? naam|uska naam|unka naam)\s*(hai|is)?\s*[:-]?\s*/i,
        "",
      )
      .replace(/\s+(hai|he|h)\s*[.!]*$/i, "")
      .replace(/[^\p{L}\s.'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (name.length < 2) return this.reply(this.t("ask_name"));
    this.state.newPatientName = name.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
    return this.continueBooking();
  }

  private gotReason(text: string, u: Understanding) {
    // Not sure what treatment is needed → book a consultation, not a treatment slot (Build Prompt §6.3).
    this.state.procedureId = u.procedureId ?? matchProcedure(text, this.procedures) ?? this.consultationId();
    if (!this.state.fromDate && u.date) {
      this.state.fromDate = u.date.fromDate;
      this.state.toDate = u.date.toDate;
    }
    this.state.partsOfDay = this.state.partsOfDay ?? u.partsOfDay;
    return this.offer({});
  }

  private async continueBooking() {
    if (!this.state.procedureId) {
      this.state.step = "reason";
      return this.reply(this.t("ask_reason"));
    }
    return this.offer({});
  }

  /** Finds and holds up to three spread-out options and shows them as buttons. */
  private async offer(
    change: {
      date?: { fromDate: string; toDate: string } | null;
      partsOfDay?: string[] | null;
      later?: boolean;
    },
    prefix?: CopyKey,
  ) {
    const procedureId = this.state.procedureId ?? this.consultationId();
    if (!procedureId) return this.human("No consultation procedure configured");
    const holder = `wa:${this.ctx.conversation.id}`;
    await releaseHolds(this.q, holder);

    if (change.date) {
      this.state.fromDate = change.date.fromDate;
      this.state.toDate = change.date.toDate;
    }
    if (change.partsOfDay !== undefined && change.partsOfDay !== null)
      this.state.partsOfDay = change.partsOfDay;
    if (change.later) {
      const lastShown = this.state.options?.at(-1)?.start;
      const after = lastShown
        ? addDays(localDateOf(new Date(lastShown), this.clinic.timezone), 1)
        : addDays(this.today(), 1);
      this.state.fromDate = after;
      this.state.toDate = undefined;
    }

    const search = async (from?: string, to?: string) =>
      offerSlots(this.q, {
        procedureId,
        fromDate: from,
        toDate: to ?? (from ? addDays(from, 6) : undefined),
        partsOfDay: (this.state.partsOfDay as ("morning" | "afternoon" | "evening")[] | null) ?? undefined,
        doctorId: undefined,
        now: this.ctx.now,
        count: 3,
        holder,
      });

    let holds: Hold[] = await search(this.state.fromDate, this.state.toDate);
    if (holds.length === 0 && this.state.fromDate) {
      // Nothing on the requested days: say so and offer the next free times.
      this.reply(this.t("no_slots"));
      holds = await search(addDays(this.state.toDate ?? this.state.fromDate, 1));
    }
    if (holds.length === 0) {
      await this.task(
        "callback",
        "high",
        "Could not find a free slot on WhatsApp",
        this.procedureName(procedureId),
        `noslot:${this.ctx.conversation.id}:${this.today()}`,
      );
      this.resetFlow();
      return this.reply(this.t("no_slots_at_all"));
    }

    this.state.step = "slots";
    this.state.options = holds.map((h) => ({
      holdId: h.holdId,
      start: h.start.toISOString(),
      end: h.end.toISOString(),
      doctorId: h.doctorId,
    }));
    const list = holds.map((h, i) => `${i + 1}. ${this.when(h.start)}`).join("\n");
    this.reply(
      `${prefix ? `${this.t(prefix)}\n` : ""}${this.t("offer_slots", { procedure: this.procedureName(procedureId) })}\n${list}`,
      [
        ...holds.map((h) => ({
          id: `slot:${h.holdId}`,
          title: buttonLabel(h.start, this.clinic.timezone, this.lang === "hi" ? "hi" : "en"),
        })),
      ],
    );
    if (holds.length < 3)
      this.reply(this.t("pick_from_buttons"), [{ id: "more", title: this.t("btn_more_dates") }]);
  }

  private async chooseSlot(holdId: string) {
    const option = this.state.options?.find((o) => o.holdId === holdId);
    if (!option) return this.offer({}, "slot_gone");
    this.state.chosenHoldId = holdId;
    this.state.step = "confirm";
    const doctor =
      (await this.q.query("select name from doctors where id = $1", [option.doctorId])).rows[0]?.name ?? "";
    const patient = await this.patientName();
    const key: CopyKey = this.state.flow === "reschedule" ? "confirm_reschedule" : "confirm_booking";
    this.reply(this.t(key, { patient, when: this.when(option.start), doctor }), [
      { id: "yes_book", title: this.t("btn_yes_book") },
      { id: "other_time", title: this.t("btn_other_time") },
    ]);
  }

  private async patientName(): Promise<string> {
    if (this.state.patientId) {
      const { rows } = await this.q.query("select name from patients where id = $1", [this.state.patientId]);
      return rows[0]?.name ?? "";
    }
    if (this.state.appointmentId) {
      const { rows } = await this.q.query(
        "select p.name from appointments a join patients p on p.id = a.patient_id where a.id = $1",
        [this.state.appointmentId],
      );
      return rows[0]?.name ?? "";
    }
    return this.state.newPatientName ?? "";
  }

  private async confirmBooking() {
    const holdId = this.state.chosenHoldId;
    if (!holdId) return this.welcome();
    let patientId = this.state.patientId;
    if (!patientId) {
      const created = await createPatient(this.q, {
        name: this.state.newPatientName ?? "WhatsApp patient",
        phone: this.ctx.conversation.phone,
        source: "whatsapp",
      });
      patientId = created.id;
      if (this.state.relationship) {
        const owner = (await this.phonePatients()).find((p) => p.id !== patientId);
        if (owner)
          await linkFamily(this.q, {
            patientId: owner.id,
            relatedPatientId: patientId,
            relationship: this.state.relationship,
          });
      }
    }
    try {
      const appointment = await bookFromHold(this.q, {
        holdId,
        patientId,
        source: "whatsapp",
        idempotencyKey: `wa:${this.ctx.inboundMessageId}`,
      });
      const doctor =
        (await this.q.query("select name from doctors where id = $1", [appointment.doctorId])).rows[0]
          ?.name ?? "";
      const patient =
        (await this.q.query("select name from patients where id = $1", [patientId])).rows[0]?.name ?? "";
      await this.q.query("update conversations set patient_id = coalesce(patient_id, $2) where id = $1", [
        this.ctx.conversation.id,
        patientId,
      ]);
      this.resetFlow();
      this.reply(this.t("booked", { patient, when: this.when(appointment.startsAt), doctor }));
    } catch (error) {
      if (error instanceof DomainError && (error.code === "slot_taken" || error.code === "hold_not_found")) {
        this.state.patientId = patientId;
        return this.offer({}, "slot_gone");
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- existing appointments

  private async upcoming() {
    const { rows } = await this.q.query(
      `select a.id, a.starts_at, a.procedure_type_id, a.patient_id, p.name as patient, d.name as doctor
       from appointments a join patients p on p.id = a.patient_id join doctors d on d.id = a.doctor_id
       where (p.phone = $1 or p.alt_phone = $1) and p.deleted_at is null and a.status = any($2) and a.starts_at > $3
       order by a.starts_at limit 5`,
      [this.ctx.conversation.phone, upcomingStatuses, this.ctx.now],
    );
    return rows as {
      id: string;
      starts_at: Date;
      procedure_type_id: string | null;
      patient_id: string;
      patient: string;
      doctor: string;
    }[];
  }

  private async listAppointments() {
    const list = await this.upcoming();
    if (list.length === 0)
      return this.reply(this.t("no_upcoming"), [{ id: "book", title: this.t("btn_book") }]);
    const lines = list.map((a) => `• ${a.patient}: ${this.when(a.starts_at)}, ${a.doctor}`).join("\n");
    if (list.length === 1) {
      this.state.appointmentId = list[0]!.id;
      return this.reply(this.t("your_appointments", { list: lines }), [
        { id: `appt:${list[0]!.id}`, title: this.t("btn_reschedule") },
        { id: `cancel:${list[0]!.id}`, title: this.t("btn_cancel") },
      ]);
    }
    return this.reply(this.t("your_appointments", { list: lines }));
  }

  private async pickAppointment(flow: "reschedule" | "cancel") {
    const list = await this.upcoming();
    const lang = this.state.lang;
    this.state = { lang, flow };
    if (list.length === 0)
      return this.reply(this.t("no_upcoming"), [{ id: "book", title: this.t("btn_book") }]);
    if (list.length === 1) {
      this.state.appointmentId = list[0]!.id;
      return flow === "cancel" ? this.askCancel() : this.startReschedule();
    }
    this.state.step = "appt_pick";
    this.state.appointmentChoices = list.slice(0, 3).map((a) => a.id);
    const lines = list
      .slice(0, 3)
      .map((a, i) => `${i + 1}. ${a.patient}: ${this.when(a.starts_at)}`)
      .join("\n");
    return this.reply(
      `${this.t("choose_appointment")}\n${lines}`,
      list
        .slice(0, 3)
        .map((a) => ({
          id: `appt:${a.id}`,
          title: buttonLabel(a.starts_at, this.clinic.timezone, this.lang === "hi" ? "hi" : "en"),
        })),
    );
  }

  /** The appointment must belong to someone using this phone number (Build Prompt §6.7). */
  private async ownAppointment(id: string) {
    const { rows } = await this.q.query(
      `select a.id, a.starts_at, a.status, a.procedure_type_id, a.patient_id, p.name as patient
       from appointments a join patients p on p.id = a.patient_id
       where a.id = $1 and (p.phone = $2 or p.alt_phone = $2)`,
      [id, this.ctx.conversation.phone],
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
    const a = this.state.appointmentId ? await this.ownAppointment(this.state.appointmentId) : undefined;
    if (!a) return this.listAppointments();
    this.state.flow = "cancel";
    this.state.step = "cancel_confirm";
    this.reply(this.t("confirm_cancel", { patient: a.patient, when: this.when(a.starts_at) }), [
      { id: "cancel_yes", title: this.t("btn_yes_cancel") },
      { id: "keep", title: this.t("btn_keep") },
    ]);
  }

  private async doCancel() {
    const a = this.state.appointmentId ? await this.ownAppointment(this.state.appointmentId) : undefined;
    if (!a) return this.welcome();
    await cancelAppointment(this.q, a.id, "Cancelled by patient on WhatsApp");
    this.resetFlow();
    this.reply(this.t("cancelled", { patient: a.patient, when: this.when(a.starts_at) }), [
      { id: "book", title: this.t("btn_book") },
    ]);
  }

  private async startReschedule() {
    const a = this.state.appointmentId ? await this.ownAppointment(this.state.appointmentId) : undefined;
    if (!a) return this.listAppointments();
    this.state.flow = "reschedule";
    this.state.patientId = a.patient_id;
    this.state.procedureId = a.procedure_type_id ?? this.consultationId();
    return this.offer({});
  }

  private async confirmReschedule() {
    const option = this.state.options?.find((o) => o.holdId === this.state.chosenHoldId);
    const a = this.state.appointmentId ? await this.ownAppointment(this.state.appointmentId) : undefined;
    if (!option || !a) return this.welcome();
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
      await releaseHolds(this.q, `wa:${this.ctx.conversation.id}`);
      const doctor =
        (await this.q.query("select name from doctors where id = $1", [appointment.doctorId])).rows[0]
          ?.name ?? "";
      this.resetFlow();
      this.reply(
        this.t("rescheduled", { patient: a.patient, when: this.when(appointment.startsAt), doctor }),
      );
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === "slot_taken" || error.code === "needs_confirmation")
      )
        return this.offer({}, "slot_gone");
      throw error;
    }
  }

  private async reminderButton(payload: string) {
    const [action, id] = payload.split(":") as ["confirm" | "reschedule" | "cancel", string];
    const a = await this.ownAppointment(id);
    if (!a || !upcomingStatuses.includes(a.status)) return this.listAppointments();
    this.state.appointmentId = a.id;
    if (action === "confirm") {
      if (a.status === "booked") await setAppointmentStatus(this.q, a.id, "confirmed");
      this.resetFlow();
      return this.reply(this.t("reminder_confirmed", { when: this.when(a.starts_at) }));
    }
    if (action === "cancel") return this.askCancel();
    return this.startReschedule();
  }

  // ---------------------------------------------------------------- information

  private async timings() {
    const { rows } = await this.q.query(
      "select weekday, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e from working_hours where doctor_id is null order by weekday, start_time",
    );
    const days =
      this.lang === "hi"
        ? ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"]
        : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const byDay = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
      day: days[d]!,
      hours:
        rows
          .filter((r) => r.weekday === d)
          .map((r) => `${r.s}–${r.e}`)
          .join(", ") || this.t("closed_word"),
    }));
    // Merge consecutive days with the same hours: "Monday–Saturday: 10:00–14:00, 17:00–21:00".
    const lines: string[] = [];
    for (let i = 0; i < byDay.length;) {
      let j = i;
      while (j + 1 < byDay.length && byDay[j + 1]!.hours === byDay[i]!.hours) j++;
      lines.push(`${i === j ? byDay[i]!.day : `${byDay[i]!.day}–${byDay[j]!.day}`}: ${byDay[i]!.hours}`);
      i = j + 1;
    }
    const holidays = (
      await this.q.query(
        "select date::text, name from holidays where date between $1 and $2 order by date limit 3",
        [this.today(), addDays(this.today(), 30)],
      )
    ).rows;
    this.reply(
      this.t("timings", {
        hours: lines.join("\n"),
        holidays: holidays.length
          ? this.t("holiday_line", { list: holidays.map((h) => `${h.date} (${h.name})`).join(", ") })
          : "",
      }),
    );
  }

  private location() {
    if (!this.clinic.address && !this.clinic.mapsUrl)
      return this.human("Asked for address; clinic address not set");
    this.reply(
      this.t("location", {
        address: this.clinic.address ?? "",
        maps: this.clinic.mapsUrl ? `\n${this.clinic.mapsUrl}` : "",
      }),
    );
  }

  private price(procedureId: string) {
    const p = this.procedures.find((x) => x.id === procedureId);
    this.state.step = undefined;
    // Only prices the clinic entered and approved for patients (Build Prompt §6.4).
    if (!p || !p.pricePublic || p.priceMin === null || p.priceMax === null) {
      return this.reply(this.t("price_unknown"), [{ id: "consult", title: this.t("btn_consultation") }]);
    }
    const rupees = (paise: number) => `₹${new Intl.NumberFormat("en-IN").format(Math.round(paise / 100))}`;
    this.reply(
      this.t("price", {
        procedure: this.procedureName(p.id),
        min: rupees(p.priceMin),
        max: rupees(p.priceMax),
      }),
      [{ id: "consult", title: this.t("btn_consultation") }],
    );
  }

  private async doctors() {
    const { rows } = await this.q.query(
      `select d.name, d.speciality, d.kind,
              coalesce(string_agg(distinct v.weekday::text, ',' ), '') as days
       from doctors d left join doctor_visiting_schedules v on v.doctor_id = d.id
       where d.active and d.kind <> 'on_call' group by d.id order by d.kind, d.name`,
    );
    const days =
      this.lang === "hi"
        ? ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const list = rows
      .map((d) => {
        const visiting =
          d.kind === "visiting" && d.days
            ? ` (${d.days
                .split(",")
                .map((x: string) => days[Number(x)])
                .join(", ")})`
            : "";
        return `• ${d.name}${d.speciality ? `, ${d.speciality}` : ""}${visiting}`;
      })
      .join("\n");
    this.reply(this.t("doctors", { list }), [{ id: "book", title: this.t("btn_book") }]);
  }
}

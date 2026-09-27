import { randomUUID } from "node:crypto";
import { FakeLLMProvider } from "@dentalos/adapters";
import { withClinic, type Pool } from "@dentalos/db";
import { endCall, loadFacts, runVoiceTurn, type CallRef, type TurnResult } from "../voice/call";
import type { ClinicFacts } from "../voice/dialog";
import { routeInboundCall, type CallRoute } from "../voice/routing";
import { setupWhatsAppClinic } from "./harness";

/**
 * Plays a caller against the phone assistant at the text level (the media server adds audio on top; its
 * own tests cover that). Used by the voice acceptance tests and the eval suite.
 */
export const VOICE_NUMBER = "+918047112233";
export const CLINIC_PHONE = "+916512345678";

export async function setupVoiceClinic(pool: Pool, name = "Sharma Dental Clinic") {
  const clinic = await setupWhatsAppClinic(pool, name);
  await withClinic(pool, { clinicId: clinic.clinicId, actor: "system", role: "owner" }, async (c) => {
    await c.query("update clinics set phone = $2 where id = $1", [clinic.clinicId, CLINIC_PHONE]);
    await c.query(
      "insert into clinic_channels (clinic_id, kind, external_id, display_phone) values (app.current_clinic_id(), 'voice', $1, $1)",
      [VOICE_NUMBER],
    );
  });
  return clinic;
}

export class CallerSimulator {
  readonly llm = new FakeLLMProvider();
  readonly heard: string[] = [];
  call!: CallRef & { route: CallRoute };
  facts!: ClinicFacts;
  last: TurnResult | null = null;
  ended = false;

  constructor(
    private readonly pool: Pool,
    readonly phone: string | null,
    public now: Date,
  ) {}

  /** Dials the clinic; returns what the assistant said first. */
  async dial(options: { voiceHealthy?: boolean } = {}) {
    const routed = await routeInboundCall(
      this.pool,
      { provider: "fake", providerCallId: randomUUID(), from: this.phone, to: VOICE_NUMBER },
      { voiceHealthy: options.voiceHealthy ?? true, now: this.now },
    );
    if (!routed) throw new Error("number not routed to a clinic");
    this.call = { clinicId: routed.clinicId, callId: routed.callId, phone: this.phone, route: routed.route };
    if (routed.route !== "assistant") return [];
    this.facts = await loadFacts(this.pool, routed.clinicId);
    return this.turn({ kind: "start" });
  }

  private async turn(input: Parameters<typeof runVoiceTurn>[3]) {
    if (this.ended) throw new Error("call already ended");
    this.last = await runVoiceTurn(this.pool, this.call, this.facts, input, {
      llm: this.llm,
      now: () => this.now,
    });
    const said = this.last.say.map((u) => u.text);
    this.heard.push(...said);
    if (this.last.end) {
      this.ended = true;
      await endCall(this.pool, this.call, { sttMs: 0, ttsChars: 0 });
    }
    return said;
  }

  say(text: string, language: string | null = null) {
    return this.turn({ kind: "speech", text, language });
  }

  silence() {
    return this.turn({ kind: "no_input" });
  }

  mumble() {
    return this.turn({ kind: "unclear" });
  }

  press(digit: string) {
    return this.turn({ kind: "dtmf", digit });
  }

  async hangUp() {
    if (!this.ended) {
      this.ended = true;
      await endCall(this.pool, this.call, { sttMs: 0, ttsChars: 0 });
    }
  }

  /** The call row as staff will see it. */
  async record() {
    return (await this.pool.query("select * from calls where id = $1", [this.call.callId])).rows[0];
  }
}

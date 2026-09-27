import type { LLMProvider } from "@dentalos/adapters";
import { meterCall, releaseHolds } from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import {
  initialVoiceState,
  loadClinicFacts,
  summarizeCall,
  VoiceDialog,
  type ClinicFacts,
  type VoiceInput,
  type VoiceState,
  type VoiceTurn,
} from "./dialog";

/**
 * Runs one turn of a phone call: loads the call's state, lets the dialog decide, records the transcript and
 * saves everything in one transaction. Used by the voice media server and by the tests and evals.
 */
export interface CallRef {
  clinicId: string;
  callId: string;
  phone: string | null;
}

const ctxFor = (clinicId: string) => ({ clinicId, actor: "agent:voice" as const, role: "agent" as const });

export async function loadFacts(pool: Pool, clinicId: string): Promise<ClinicFacts> {
  return withClinic(pool, ctxFor(clinicId), (c) => loadClinicFacts(c));
}

export interface TurnResult extends VoiceTurn {
  assistantTurnId: string | null;
  state: VoiceState;
}

export async function runVoiceTurn(
  pool: Pool,
  call: CallRef,
  facts: ClinicFacts,
  input: VoiceInput,
  deps: { llm?: LLMProvider; now?: () => Date } = {},
): Promise<TurnResult> {
  return withClinic(pool, ctxFor(call.clinicId), async (c) => {
    const row = (
      await c.query("select state, status, purpose, subject_id from calls where id = $1 for update", [
        call.callId,
      ])
    ).rows[0];
    if (!row) throw new Error("call not found");
    const saved = row.state as Partial<VoiceState>;
    const state: VoiceState = saved && saved.lang ? (saved as VoiceState) : initialVoiceState(facts);
    const dialog = new VoiceDialog(facts, state);

    const addTurn = async (speaker: "caller" | "assistant" | "system", text: string, flags: string[] = []) =>
      (
        await c.query(
          `insert into call_turns (clinic_id, call_id, seq, speaker, text, language, flags)
           values (app.current_clinic_id(), $1, coalesce((select max(seq) from call_turns where call_id = $1), 0) + 1, $2, $3, $4, $5)
           returning id`,
          [call.callId, speaker, text, state.lang, flags],
        )
      ).rows[0].id as string;

    if (input.kind === "speech") await addTurn("caller", input.text);
    else if (input.kind === "unclear") await addTurn("system", "(speech not understood)", ["stt_failed"]);
    else if (input.kind === "no_input") await addTurn("system", "(silence)", ["no_input"]);
    else if (input.kind === "dtmf") await addTurn("caller", `(pressed ${input.digit})`, ["dtmf"]);

    const turn = await dialog.handle(
      {
        client: c,
        callId: call.callId,
        phone: call.phone,
        now: deps.now?.() ?? new Date(),
        llm: deps.llm,
        purpose: row.purpose,
        subjectId: row.subject_id,
      },
      input,
    );
    const flags = [
      ...(turn.emergency ? ["emergency"] : []),
      ...(turn.end?.kind === "transfer" ? [`transfer_${turn.end.to}`] : []),
    ];
    const assistantTurnId = turn.say.length
      ? await addTurn("assistant", turn.say.map((u) => u.text).join(" "), flags)
      : null;

    await c.query(
      `update calls set state = $2, language = $3, intents = $4, outcome = coalesce($5, outcome), summary = $6,
              status = case when status = 'ringing' then 'in_progress' else status end,
              answered_at = coalesce(answered_at, now())
       where id = $1`,
      [
        call.callId,
        state,
        state.lang === "hi" ? "hi-IN" : "en-IN",
        state.intents,
        state.outcome ?? null,
        summarizeCall(state),
      ],
    );
    return { ...turn, assistantTurnId, state };
  });
}

/** Records how fast the assistant answered (ms from the caller stopping to the first reply audio). */
export async function recordLatency(pool: Pool, call: CallRef, turnId: string, latencyMs: number) {
  await withClinic(pool, ctxFor(call.clinicId), (c) =>
    c.query("update call_turns set latency_ms = $2 where id = $1", [turnId, Math.round(latencyMs)]),
  );
}

/** Media stream closed: finish the call record and free any slots still held for it. */
export async function endCall(
  pool: Pool,
  call: CallRef,
  usage: { sttMs: number; ttsChars: number; llmInputTokens?: number; llmOutputTokens?: number },
  now: Date = new Date(),
) {
  await withClinic(pool, ctxFor(call.clinicId), async (c) => {
    await releaseHolds(c, `call:${call.callId}`);
    const lat = (
      await c.query(
        `select percentile_cont(0.5) within group (order by latency_ms)::int as p50,
                percentile_cont(0.95) within group (order by latency_ms)::int as p95,
                max(latency_ms) as max, count(*)::int as turns
         from call_turns where call_id = $1 and speaker = 'assistant' and latency_ms is not null`,
        [call.callId],
      )
    ).rows[0];
    await c.query(
      `update calls set
         status = case when status = 'transferring' then 'transferring' else 'ended' end,
         outcome = coalesce(outcome, case when status = 'transferring' then 'transferred' else 'caller_hung_up' end),
         ended_at = case when status = 'transferring' then ended_at else coalesce(ended_at, $4) end,
         usage = usage || $2::jsonb,
         latency = $3::jsonb
       where id = $1`,
      [
        call.callId,
        JSON.stringify({
          stt_ms: usage.sttMs,
          tts_chars: usage.ttsChars,
          llm_input_tokens: usage.llmInputTokens ?? 0,
          llm_output_tokens: usage.llmOutputTokens ?? 0,
        }),
        JSON.stringify(lat.turns ? { p50: lat.p50, p95: lat.p95, max: lat.max, turns: lat.turns } : {}),
        now,
      ],
    );
    // Speech and model usage now; telephone minutes when the provider reports the duration.
    await meterCall(c, call.callId, now);
  });
}

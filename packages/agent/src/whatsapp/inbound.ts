import type { LLMProvider, MessagingChannel, MessagingProvider, SpeechProvider } from "@dentalos/adapters";
import { canUse, countingLLM, getConversation, meter, type JobQueue, scheduleSend } from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import { runAssistant, type AssistantInput } from "./assistant";

export interface InboundDeps {
  pool: Pool;
  jobs: JobQueue;
  llm?: LLMProvider;
  voice?: SpeechProvider;
  messaging?: MessagingProvider;
  /** The clinic's WhatsApp channel (to download voice notes). */
  channel?: (clinicId: string) => Promise<MessagingChannel | null>;
  now?: () => Date;
}

/**
 * Worker job for one inbound WhatsApp message. Idempotent: a message is answered once even if the job
 * runs again. Replies are queued in the same transaction as any booking, and sent only after it commits.
 */
export async function processInboundMessage(
  deps: InboundDeps,
  clinicId: string,
  messageId: string,
): Promise<{ replies: number; skipped?: string }> {
  const ctx = { clinicId, actor: "agent:whatsapp" as const, role: "agent" as const };

  // Voice notes: transcribe before opening the transaction (network call).
  const pre = await withClinic(
    deps.pool,
    ctx,
    async (c) =>
      (await c.query("select kind, body, payload from messages where id = $1", [messageId])).rows[0],
  );
  if (!pre) return { replies: 0, skipped: "not found" };
  // While the usage wallet is paused, the assistant works by rules only: no speech-to-text, no model
  // (PLAN §5.6). Emergency detection is rules-based and keeps working.
  const aiAllowed = await withClinic(deps.pool, ctx, (c) => canUse(c, "ai_chat"));
  if (
    aiAllowed &&
    pre.kind === "audio" &&
    !pre.body &&
    !pre.payload?.transcribeFailed &&
    deps.voice &&
    deps.messaging &&
    deps.channel
  ) {
    let transcript: string | null = null;
    let audioMs = 0;
    try {
      const channel = await deps.channel(clinicId);
      if (channel) {
        const media = await deps.messaging.downloadMedia(channel, String(pre.payload.mediaId));
        const heard = await deps.voice.transcribe({
          format: "file",
          audio: media.bytes,
          mimeType: media.mimeType,
          language: "auto",
        });
        audioMs = heard.audioMs;
        transcript = heard.text.trim() || null;
      }
    } catch {
      transcript = null;
    }
    await withClinic(deps.pool, ctx, async (c) => {
      await c.query("update messages set body = $2, payload = payload || $3 where id = $1", [
        messageId,
        transcript,
        transcript ? { transcribed: true } : { transcribeFailed: true },
      ]);
      await meter(c, {
        kind: "stt_sec",
        quantity: Math.round(audioMs / 100) / 10,
        refType: "message",
        ref: messageId,
      });
    });
  }

  const outcome = await withClinic(deps.pool, ctx, async (c) => {
    // Lock the chat, so two messages from the same patient never run the assistant at the same time.
    await c.query(
      "select 1 from conversations where id = (select conversation_id from messages where id = $1) for update",
      [messageId],
    );
    const { rows } = await c.query(
      "update messages set payload = payload || '{\"processed\": true}' where id = $1 and direction = 'in' and not coalesce((payload->>'processed')::boolean, false) returning conversation_id, kind, body, payload",
      [messageId],
    );
    const m = rows[0];
    if (!m) return null;
    const conversation = await getConversation(c, m.conversation_id);
    if (!conversation) return null;
    const input: AssistantInput =
      m.kind === "button_reply"
        ? { kind: "button", payload: String(m.payload.buttonPayload ?? ""), title: m.body ?? "" }
        : m.kind === "audio"
          ? m.body
            ? { kind: "text", text: m.body }
            : { kind: "voice_failed" }
          : m.kind === "image" || m.kind === "document"
            ? { kind: "media", mediaKind: m.kind }
            : { kind: "text", text: m.body ?? "" };
    const counted = deps.llm && aiAllowed ? countingLLM(deps.llm) : null;
    const result = await runAssistant(
      {
        client: c,
        conversation,
        inboundMessageId: messageId,
        llm: counted?.llm,
        now: deps.now?.() ?? new Date(),
      },
      input,
    );
    if (counted) {
      await meter(c, {
        kind: "llm_input_token",
        quantity: counted.usage.input,
        refType: "message",
        ref: messageId,
      });
      await meter(c, {
        kind: "llm_output_token",
        quantity: counted.usage.output,
        refType: "message",
        ref: messageId,
      });
    }
    return result;
  });
  if (!outcome) return { replies: 0, skipped: "already processed" };
  for (const id of outcome.outboxIds) await scheduleSend(deps.jobs, clinicId, id);
  return { replies: outcome.outboxIds.length };
}

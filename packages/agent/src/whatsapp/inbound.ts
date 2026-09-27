import type { LLMProvider, MessagingChannel, MessagingProvider, SpeechProvider } from "@dentalos/adapters";
import { getConversation, type JobQueue, scheduleSend } from "@dentalos/core";
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
  if (
    pre.kind === "audio" &&
    !pre.body &&
    !pre.payload?.transcribeFailed &&
    deps.voice &&
    deps.messaging &&
    deps.channel
  ) {
    let transcript: string | null = null;
    try {
      const channel = await deps.channel(clinicId);
      if (channel) {
        const media = await deps.messaging.downloadMedia(channel, String(pre.payload.mediaId));
        transcript =
          (
            await deps.voice.transcribe({
              format: "file",
              audio: media.bytes,
              mimeType: media.mimeType,
              language: "auto",
            })
          ).text.trim() || null;
      }
    } catch {
      transcript = null;
    }
    await withClinic(deps.pool, ctx, (c) =>
      c.query("update messages set body = $2, payload = payload || $3 where id = $1", [
        messageId,
        transcript,
        transcript ? { transcribed: true } : { transcribeFailed: true },
      ]),
    );
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
    return runAssistant(
      {
        client: c,
        conversation,
        inboundMessageId: messageId,
        llm: deps.llm,
        now: deps.now?.() ?? new Date(),
      },
      input,
    );
  });
  if (!outcome) return { replies: 0, skipped: "already processed" };
  for (const id of outcome.outboxIds) await scheduleSend(deps.jobs, clinicId, id);
  return { replies: outcome.outboxIds.length };
}

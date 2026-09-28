import type { MessagingEvent } from "@dentalos/adapters";
import {
  createLead,
  ensureConversation,
  leadWhatsAppFailed,
  logMessage,
  needFromText,
  type JobQueue,
} from "@dentalos/core";
import { withAppRole, withClinic, type Pool } from "@dentalos/db";

/**
 * Stores what WhatsApp sent us and queues the work; answers Meta quickly (webhooks must return within
 * seconds). Every event is processed once, however often Meta retries it.
 */
export async function ingestMessagingEvents(
  pool: Pool,
  jobs: JobQueue,
  events: MessagingEvent[],
): Promise<{ accepted: number; duplicates: number; unrouted: number }> {
  let accepted = 0;
  let duplicates = 0;
  let unrouted = 0;
  for (const event of events) {
    const clinicId = await withAppRole(
      pool,
      async (c) =>
        (await c.query("select app.clinic_for_channel('whatsapp', $1) as id", [event.channelId])).rows[0]
          .id as string | null,
    );
    if (!clinicId) {
      unrouted++;
      continue;
    }
    const fresh = await withAppRole(
      pool,
      async (c) =>
        (await c.query("select app.claim_webhook_event('whatsapp', $1, $2) as ok", [event.eventId, clinicId]))
          .rows[0].ok as boolean,
    );
    if (!fresh) {
      duplicates++;
      continue;
    }
    accepted++;
    const ctx = { clinicId, actor: "system" as const, role: "system" as const };

    if (event.type === "status") {
      await withClinic(pool, ctx, async (c) => {
        const { rows } = await c.query(
          `update messages m set status = $2, error = coalesce($3, error)
           where provider_message_id = $1 and status not in ('read') and not (status = 'delivered' and $2 = 'sent')
           returning (select phone from conversations where id = m.conversation_id) as phone`,
          [event.providerMessageId, event.status, event.errorCode ?? null],
        );
        // A lead WhatsApp can't reach (not on WhatsApp, wrong number): a person calls them instead.
        if (event.status === "failed" && rows[0]?.phone)
          await leadWhatsAppFailed(c, { phone: rows[0].phone, errorCode: event.errorCode, now: event.at });
      });
      continue;
    }

    const { messageId, conversationId } = await withClinic(pool, ctx, async (c) => {
      const conversation = await ensureConversation(c, event.from);
      const content = event.content;
      const id = await logMessage(c, {
        conversationId: conversation.id,
        direction: "in",
        author: "patient",
        kind: content.kind === "button_reply" ? "button_reply" : content.kind,
        body:
          content.kind === "text"
            ? content.text
            : content.kind === "button_reply"
              ? content.title
              : "caption" in content
                ? (content.caption ?? null)
                : null,
        payload: {
          ...(content.kind === "button_reply" ? { buttonPayload: content.payload } : {}),
          ...("mediaId" in content ? { mediaId: content.mediaId, mimeType: content.mimeType } : {}),
          ...(event.profileName ? { profileName: event.profileName } : {}),
        },
        providerMessageId: event.providerMessageId,
        status: "received",
        at: event.at,
      });
      if (!conversation.patientId) {
        await c.query(
          `update conversations set patient_id = (select id from patients where phone = $2 and deleted_at is null order by created_at limit 1)
           where id = $1 and patient_id is null`,
          [conversation.id, event.from],
        );
      }
      // Tapped a Click-to-WhatsApp ad: a lead, already talking to the assistant (Phase 6).
      if (event.referral?.sourceType === "ad") {
        const text = content.kind === "text" ? content.text : "";
        await createLead(c, {
          source: "ctwa",
          externalId: event.referral.ctwaClid ?? event.providerMessageId,
          phone: event.from,
          name: event.profileName ?? null,
          campaign: event.referral.headline ?? null,
          ad: event.referral.sourceId ?? null,
          need:
            needFromText([event.referral.headline, event.referral.body, text].filter(Boolean).join(" ")) ??
            null,
          answers: {
            ...(event.referral.headline ? { ad_headline: event.referral.headline } : {}),
            ...(text ? { first_message: text.slice(0, 500) } : {}),
          },
          alreadyTalking: true,
          now: event.at,
        });
      }
      return { messageId: id, conversationId: conversation.id };
    });
    // One queue per chat: a patient's messages are answered one at a time, in the order they arrived.
    await jobs.add(
      "process_inbound",
      { clinicId, messageId },
      { jobKey: `inbound:${messageId}`, queueName: `chat:${conversationId}` },
    );
  }
  return { accepted, duplicates, unrouted };
}

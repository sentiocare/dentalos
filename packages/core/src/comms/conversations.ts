import type { PoolClient } from "pg";

export interface Conversation {
  id: string;
  phone: string;
  patientId: string | null;
  mode: "bot" | "human";
  lastInboundAt: Date | null;
  state: Record<string, unknown>;
}

function toConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as string,
    phone: r.phone as string,
    patientId: r.patient_id as string | null,
    mode: r.mode as Conversation["mode"],
    lastInboundAt: r.last_inbound_at as Date | null,
    state: (r.state as Record<string, unknown>) ?? {},
  };
}

export async function ensureConversation(client: PoolClient, phone: string): Promise<Conversation> {
  const { rows } = await client.query(
    `insert into conversations (clinic_id, channel, phone) values (app.current_clinic_id(), 'whatsapp', $1)
     on conflict (clinic_id, channel, phone) do update set phone = excluded.phone
     returning *`,
    [phone],
  );
  return toConversation(rows[0]);
}

export async function getConversation(client: PoolClient, id: string): Promise<Conversation | null> {
  const { rows } = await client.query("select * from conversations where id = $1", [id]);
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function saveConversationState(client: PoolClient, id: string, state: Record<string, unknown>) {
  await client.query("update conversations set state = $2 where id = $1", [id, state]);
}

export interface LoggedMessage {
  conversationId: string;
  direction: "in" | "out";
  author: "patient" | "bot" | "staff" | "system";
  authorUserId?: string | null;
  kind: "text" | "template" | "buttons" | "button_reply" | "audio" | "image" | "document" | "unsupported";
  body?: string | null;
  payload?: Record<string, unknown>;
  templateName?: string | null;
  providerMessageId?: string | null;
  status: "received" | "queued" | "sent" | "delivered" | "read" | "failed" | "blocked";
  error?: string | null;
  safetyFlag?: string | null;
  at?: Date;
}

/** Stores a message and updates the conversation's preview, window and unread count. */
export async function logMessage(client: PoolClient, m: LoggedMessage): Promise<string> {
  const { rows } = await client.query(
    `insert into messages (clinic_id, conversation_id, direction, author, author_user_id, kind, body, payload, template_name,
                           provider_message_id, status, error, safety_flag, created_at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, now()))
     returning id`,
    [
      m.conversationId,
      m.direction,
      m.author,
      m.authorUserId ?? null,
      m.kind,
      m.body ?? null,
      m.payload ?? {},
      m.templateName ?? null,
      m.providerMessageId ?? null,
      m.status,
      m.error ?? null,
      m.safetyFlag ?? null,
      m.at ?? null,
    ],
  );
  const preview = (m.body ?? `[${m.kind}]`).slice(0, 140);
  if (m.direction === "in") {
    await client.query(
      `update conversations set last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2), last_message_at = $2,
         last_preview = $3, unread_count = unread_count + 1 where id = $1`,
      [m.conversationId, m.at ?? new Date(), preview],
    );
  } else if (m.status !== "blocked" && m.status !== "failed") {
    await client.query(
      "update conversations set last_outbound_at = now(), last_message_at = now(), last_preview = $2 where id = $1",
      [m.conversationId, preview],
    );
  }
  return rows[0].id;
}

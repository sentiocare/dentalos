import { ProviderError, type MessagingChannel, type MessagingProvider } from "@dentalos/adapters";
import type { PoolClient } from "pg";
import type { JobQueue } from "../jobs";
import { ensureConversation, logMessage } from "./conversations";
import { decideContact, DEFAULT_HOURS, type Category, type ContactFacts } from "./policy";
import { appointmentStillMatches } from "./reminders";
import { meter } from "../billing/metering";
import { walletAllows, walletStatus, type Capability } from "../billing/wallet";
import { renderTemplate, TEMPLATES, type TemplatePurpose } from "./templates";

export type OutboundPayload =
  | { kind: "text"; text: string }
  | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | {
      kind: "template";
      purpose: TemplatePurpose;
      language: "en" | "hi";
      params: string[];
      /** Payloads for the template's quick-reply buttons, in order. */
      buttonPayloads?: string[];
      /** For appointment messages: what must still be true when it is sent. */
      meta?: { appointmentStartsAt?: string; requireStatus?: "active" | "cancelled" };
    }
  | { kind: "document"; url: string; filename: string; caption?: string };

export interface OutboundMessage {
  to: string;
  category: Category;
  purpose: string;
  payload: OutboundPayload;
  /** Same key → same message, however many times the caller runs (retries, duplicate webhooks, reruns). */
  dedupeKey: string;
  notBefore?: Date;
  patientId?: string | null;
  appointmentId?: string | null;
}

/** Records an outgoing message. Returns its id, or null when the same dedupe key was already queued. */
export async function enqueueMessage(client: PoolClient, m: OutboundMessage): Promise<string | null> {
  const { rows } = await client.query(
    `insert into outbox (clinic_id, channel, to_phone, patient_id, appointment_id, category, purpose, payload, dedupe_key, not_before)
     values (app.current_clinic_id(), 'whatsapp', $1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
     on conflict (clinic_id, dedupe_key) do nothing
     returning id`,
    [
      m.to,
      m.patientId ?? null,
      m.appointmentId ?? null,
      m.category,
      m.purpose,
      m.payload,
      m.dedupeKey,
      m.notBefore ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Asks the worker to send soon. Safe to call more than once; the sweeper catches anything missed. */
export async function scheduleSend(jobs: JobQueue, clinicId: string, outboxId: string, runAt?: Date) {
  await jobs.add("send_outbox", { clinicId, outboxId }, { jobKey: `outbox:${outboxId}`, runAt });
}

export interface OutboxDeps {
  messaging: MessagingProvider;
  /** Returns the clinic's WhatsApp channel with decrypted credentials, or null if not connected. */
  channel: (client: PoolClient) => Promise<MessagingChannel | null>;
  now?: () => Date;
}

const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(60, 2 ** attempt) * 60_000;

export type SendOutcome =
  | { status: "sent"; providerMessageId: string }
  | { status: "retry"; at: Date; reason: string }
  | { status: "blocked" | "failed" | "skipped"; reason: string };

/**
 * Sends one outbox row, applying the communication policy at send time (opt-outs and windows may have
 * changed since it was queued). Runs inside withClinic. A row is claimed atomically, so two workers can
 * never send it twice.
 */
export async function processOutbox(
  client: PoolClient,
  outboxId: string,
  deps: OutboxDeps,
): Promise<SendOutcome> {
  const now = deps.now?.() ?? new Date();
  const claimed = await client.query(
    `update outbox set status = 'sending', attempts = attempts + 1
     where id = $1 and status = 'pending' and not_before <= $2 returning *`,
    [outboxId, now],
  );
  const row = claimed.rows[0];
  if (!row) return { status: "skipped", reason: "not due or already handled" };
  const payload = row.payload as OutboundPayload;

  const settle = async (
    status: "sent" | "failed" | "blocked",
    extra: { error?: string; messageId?: string } = {},
  ) =>
    client.query(
      "update outbox set status = $2, last_error = $3, message_id = $4, sent_at = case when $2 = 'sent' then now() end where id = $1",
      [outboxId, status, extra.error ?? null, extra.messageId ?? null],
    );
  const retry = async (at: Date, reason: string): Promise<SendOutcome> => {
    await client.query(
      "update outbox set status = 'pending', not_before = $2, last_error = $3 where id = $1",
      [outboxId, at, reason],
    );
    return { status: "retry", at, reason };
  };

  // An appointment message whose appointment moved or was cancelled since it was queued is dropped.
  if (
    row.appointment_id &&
    payload.kind === "template" &&
    !(await appointmentStillMatches(client, row.appointment_id, payload.meta))
  ) {
    await client.query(
      "update outbox set status = 'cancelled', last_error = 'appointment_changed' where id = $1",
      [outboxId],
    );
    return { status: "skipped", reason: "appointment_changed" };
  }

  // The usage wallet (PLAN §5.6): reminders wait while it is suspended, promotions while it is not paid up.
  // Safety messages, replies inside the chat window and notices to the owner always go.
  const needs: Capability | null =
    row.category === "promotional"
      ? "promotional_message"
      : row.category === "transactional"
        ? "transactional_message"
        : null;
  if (needs && !walletAllows(await walletStatus(client, now), needs)) {
    await client.query("update outbox set attempts = attempts - 1 where id = $1", [outboxId]);
    return retry(new Date(now.getTime() + 30 * 60_000), "wallet_paused");
  }

  const clinic = (
    await client.query("select name, timezone, settings from clinics where id = app.current_clinic_id()")
  ).rows[0];
  const conversation = await ensureConversation(client, row.to_phone);
  const optOuts = (
    await client.query("select channel, category from opt_outs where phone = $1 and revoked_at is null", [
      row.to_phone,
    ])
  ).rows;
  const marketing =
    (
      await client.query(
        "select granted from consents where phone = $1 and purpose = 'marketing' order by at desc limit 1",
        [row.to_phone],
      )
    ).rows[0]?.granted === true;

  let template: { name: string; language: string } | null = null;
  if (payload.kind === "template") {
    const { rows } = await client.query(
      `select name, language from message_templates where purpose = $1 and meta_status = 'approved'
       order by (language = $2) desc limit 1`,
      [payload.purpose, payload.language],
    );
    template = rows[0] ?? null;
  }

  const facts: ContactFacts = {
    category: row.category,
    channel: "whatsapp",
    now,
    timezone: clinic.timezone,
    optOuts,
    marketingConsent: marketing,
    lastInboundAt: conversation.lastInboundAt,
    hasApprovedTemplate: template !== null,
    hours: { ...DEFAULT_HOURS, ...(clinic.settings?.messaging?.hours ?? {}) },
  };
  const decision = decideContact(facts);

  if (!decision.allow) {
    if (decision.reason === "quiet_hours" && decision.retryAt) {
      await client.query("update outbox set attempts = attempts - 1 where id = $1", [outboxId]);
      return retry(decision.retryAt, "quiet_hours");
    }
    await logMessage(client, {
      conversationId: conversation.id,
      direction: "out",
      author: "system",
      kind: payload.kind === "template" ? "template" : payload.kind === "buttons" ? "buttons" : "text",
      body: previewOf(payload),
      status: "blocked",
      error: decision.reason,
    });
    await settle("blocked", { error: decision.reason });
    return { status: "blocked", reason: decision.reason };
  }

  const channel = await deps.channel(client);
  if (!channel) {
    await settle("failed", { error: "whatsapp_not_connected" });
    return { status: "failed", reason: "whatsapp_not_connected" };
  }

  try {
    const { result, kind, body, templateName } = await send(
      deps.messaging,
      channel,
      row.to_phone,
      payload,
      decision.mode,
      template,
    );
    const messageId = await logMessage(client, {
      conversationId: conversation.id,
      direction: "out",
      author: row.purpose.startsWith("assistant")
        ? "bot"
        : row.purpose.startsWith("staff")
          ? "staff"
          : "system",
      kind,
      body,
      payload: payload.kind === "buttons" ? { buttons: payload.buttons } : {},
      templateName,
      providerMessageId: result.providerMessageId,
      status: "sent",
    });
    await settle("sent", { messageId });
    // Meta charges for business-initiated templates, not for replies inside the chat window. Notices
    // about Sentio's own billing are on Sentio.
    if (templateName && payload.kind === "template" && !row.purpose.startsWith("billing_")) {
      const category = TEMPLATES[payload.purpose]?.category ?? "utility";
      await meter(client, {
        kind: category === "marketing" ? "wa_marketing" : "wa_utility",
        quantity: 1,
        refType: "outbox",
        ref: outboxId,
        at: now,
      });
    }
    return { status: "sent", providerMessageId: result.providerMessageId };
  } catch (error) {
    const retryable = error instanceof ProviderError ? error.retryable : true;
    const reason = error instanceof ProviderError ? `${error.provider}:${error.code}` : "send_error";
    if (retryable && row.attempts < MAX_ATTEMPTS)
      return retry(new Date(now.getTime() + backoffMs(row.attempts)), reason);
    await settle("failed", { error: reason });
    return { status: "failed", reason };
  }
}

function previewOf(p: OutboundPayload): string {
  switch (p.kind) {
    case "text":
      return p.text;
    case "buttons":
      return p.body;
    case "template":
      return renderTemplate(p.purpose, p.language, p.params);
    case "document":
      return p.caption ?? p.filename;
  }
}

async function send(
  messaging: MessagingProvider,
  channel: MessagingChannel,
  to: string,
  p: OutboundPayload,
  mode: "free_form" | "template",
  template: { name: string; language: string } | null,
) {
  switch (p.kind) {
    case "text":
      return {
        result: await messaging.sendText(channel, { to, text: p.text }),
        kind: "text" as const,
        body: p.text,
        templateName: null,
      };
    case "buttons":
      return {
        result: await messaging.sendButtons(channel, { to, body: p.body, buttons: p.buttons }),
        kind: "buttons" as const,
        body: p.body,
        templateName: null,
      };
    case "document":
      return {
        result: await messaging.sendDocument(channel, {
          to,
          url: p.url,
          filename: p.filename,
          caption: p.caption,
        }),
        kind: "document" as const,
        body: p.caption ?? p.filename,
        templateName: null,
      };
    case "template": {
      const text = renderTemplate(p.purpose, p.language, p.params);
      const def = TEMPLATES[p.purpose];
      if (mode === "free_form") {
        // Inside the 24-hour window the same words go as a normal message (with buttons when it has them).
        if (def.buttons && p.buttonPayloads?.length) {
          const buttons = def.buttons.map((b, i) => ({
            id: p.buttonPayloads![i] ?? `b${i}`,
            title: b[p.language],
          }));
          return {
            result: await messaging.sendButtons(channel, { to, body: text, buttons }),
            kind: "buttons" as const,
            body: text,
            templateName: null,
          };
        }
        return {
          result: await messaging.sendText(channel, { to, text }),
          kind: "text" as const,
          body: text,
          templateName: null,
        };
      }
      const result = await messaging.sendTemplate(channel, {
        to,
        templateName: template!.name,
        language: template!.language,
        bodyParams: p.params,
        buttonPayloads: p.buttonPayloads,
      });
      return { result, kind: "template" as const, body: text, templateName: template!.name };
    }
  }
}

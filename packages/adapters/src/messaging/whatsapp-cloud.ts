import { hmacSha256Hex, ProviderError, safeEqualHex, type HealthStatus, type RawWebhook } from "../common";
import type { MessagingChannel, MessagingEvent, MessagingProvider, SendResult } from "./types";

/**
 * WhatsApp Cloud API (Meta Graph API), called directly without a BSP (Build Prompt §8).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export interface WhatsAppCloudConfig {
  /** Sentio's Meta app secret: signs every webhook (X-Hub-Signature-256). */
  appSecret: string;
  /** Token we chose when subscribing the webhook in the Meta app dashboard. */
  verifyToken: string;
  graphVersion?: string;
  graphBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// Meta error codes that are worth retrying later (rate limits, temporary unavailability).
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** WhatsApp wants numbers without the "+". */
const waNumber = (e164: string) => e164.replace(/^\+/, "");
const e164 = (wa: string) => (wa.startsWith("+") ? wa : `+${wa}`);

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = "whatsapp-cloud";
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: WhatsAppCloudConfig) {
    this.base = `${config.graphBaseUrl ?? "https://graph.facebook.com"}/${config.graphVersion ?? "v23.0"}`;
    this.fetch = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async graph<T>(channel: MessagingChannel, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${channel.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(this.name, "network", `WhatsApp unreachable: ${(error as Error).name}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || json.error) {
      const code = json.error?.code;
      const retryable =
        res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE_CODES.has(code));
      // Meta's messages can echo phone numbers; keep only the code and a short reason.
      throw new ProviderError(
        this.name,
        String(code ?? res.status),
        `WhatsApp error ${code ?? res.status}`,
        retryable,
      );
    }
    return json;
  }

  private async send(
    channel: MessagingChannel,
    to: string,
    message: Record<string, unknown>,
  ): Promise<SendResult> {
    const res = await this.graph<{ messages?: { id: string }[] }>(channel, `${channel.channelId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waNumber(to),
      ...message,
    });
    const id = res.messages?.[0]?.id;
    if (!id)
      throw new ProviderError(this.name, "no_message_id", "WhatsApp did not return a message id", true);
    return { providerMessageId: id };
  }

  sendText(channel: MessagingChannel, input: { to: string; text: string }) {
    return this.send(channel, input.to, {
      type: "text",
      text: { body: input.text.slice(0, 4096), preview_url: true },
    });
  }

  sendTemplate(
    channel: MessagingChannel,
    input: {
      to: string;
      templateName: string;
      language: string;
      bodyParams: string[];
      buttonPayloads?: string[];
    },
  ) {
    const components: Record<string, unknown>[] = [];
    if (input.bodyParams.length) {
      components.push({ type: "body", parameters: input.bodyParams.map((text) => ({ type: "text", text })) });
    }
    input.buttonPayloads?.forEach((payload, index) =>
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload }],
      }),
    );
    return this.send(channel, input.to, {
      type: "template",
      template: { name: input.templateName, language: { code: input.language }, components },
    });
  }

  async sendButtons(
    channel: MessagingChannel,
    input: { to: string; body: string; buttons: { id: string; title: string }[] },
  ) {
    if (input.buttons.length < 1 || input.buttons.length > 3)
      throw new RangeError("WhatsApp allows 1 to 3 reply buttons");
    if (input.buttons.some((b) => b.title.length > 20))
      throw new RangeError("WhatsApp button titles are limited to 20 characters");
    return this.send(channel, input.to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.body.slice(0, 1024) },
        action: {
          buttons: input.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: b.title },
          })),
        },
      },
    });
  }

  sendDocument(
    channel: MessagingChannel,
    input: { to: string; url: string; filename: string; caption?: string },
  ) {
    return this.send(channel, input.to, {
      type: "document",
      document: { link: input.url, filename: input.filename, caption: input.caption },
    });
  }

  async downloadMedia(channel: MessagingChannel, mediaId: string) {
    const meta = await this.graph<{ url?: string; mime_type?: string }>(channel, encodeURIComponent(mediaId));
    if (!meta.url) throw new ProviderError(this.name, "media_missing", "Media URL not returned", false);
    const res = await this.fetch(meta.url, {
      headers: { authorization: `Bearer ${channel.accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok)
      throw new ProviderError(this.name, String(res.status), "Media download failed", res.status >= 500);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  verifySubscription(query: Record<string, string | undefined>): string | null {
    if (query["hub.mode"] !== "subscribe" || !query["hub.challenge"]) return null;
    const token = query["hub.verify_token"] ?? "";
    return token.length === this.config.verifyToken.length && safeEqualHex(token, this.config.verifyToken)
      ? query["hub.challenge"]
      : null;
  }

  async healthCheck(): Promise<HealthStatus> {
    // Per-clinic number health is checked by the channel health job; here we only confirm configuration.
    return this.config.appSecret && this.config.verifyToken
      ? { ok: true }
      : { ok: false, detail: "WhatsApp not configured" };
  }

  verifyWebhook(webhook: RawWebhook): boolean {
    const header = webhook.headers["x-hub-signature-256"];
    if (!header?.startsWith("sha256=")) return false;
    return safeEqualHex(header.slice(7), hmacSha256Hex(this.config.appSecret, webhook.rawBody));
  }

  parseWebhook(webhook: RawWebhook): MessagingEvent[] {
    if (!this.verifyWebhook(webhook))
      throw new ProviderError(this.name, "bad_signature", "Webhook signature invalid", false);
    const body = JSON.parse(webhook.rawBody) as MetaWebhook;
    const events: MessagingEvent[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value ?? {};
        const channelId = value.metadata?.phone_number_id ?? "";
        const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of value.messages ?? []) {
          events.push({
            type: "inbound_message",
            eventId: `msg:${m.id}`,
            providerMessageId: m.id,
            from: e164(m.from),
            profileName: names.get(m.from) ?? undefined,
            channelId,
            at: new Date(Number(m.timestamp) * 1000),
            content: inboundContent(m),
          });
        }
        for (const s of value.statuses ?? []) {
          events.push({
            type: "status",
            eventId: `status:${s.id}:${s.status}`,
            channelId,
            providerMessageId: s.id,
            status: s.status,
            at: new Date(Number(s.timestamp) * 1000),
            errorCode: s.errors?.[0]?.code !== undefined ? String(s.errors[0].code) : undefined,
            usage:
              s.pricing?.billable && s.status === "sent"
                ? { kind: "wa_conversation", quantity: 1, category: s.pricing.category as "utility" }
                : undefined,
          });
        }
      }
    }
    return events;
  }
}

function inboundContent(m: MetaMessage): Extract<MessagingEvent, { type: "inbound_message" }>["content"] {
  switch (m.type) {
    case "text":
      return { kind: "text", text: m.text?.body ?? "" };
    case "interactive":
      if (m.interactive?.button_reply)
        return {
          kind: "button_reply",
          payload: m.interactive.button_reply.id,
          title: m.interactive.button_reply.title,
        };
      if (m.interactive?.list_reply)
        return {
          kind: "button_reply",
          payload: m.interactive.list_reply.id,
          title: m.interactive.list_reply.title,
        };
      return { kind: "unsupported" };
    case "button":
      // Quick-reply button on a template message.
      return { kind: "button_reply", payload: m.button?.payload ?? "", title: m.button?.text ?? "" };
    case "audio":
      return { kind: "audio", mediaId: m.audio?.id ?? "", mimeType: m.audio?.mime_type ?? "audio/ogg" };
    case "image":
      return {
        kind: "image",
        mediaId: m.image?.id ?? "",
        mimeType: m.image?.mime_type ?? "image/jpeg",
        caption: m.image?.caption,
      };
    case "document":
      return {
        kind: "document",
        mediaId: m.document?.id ?? "",
        mimeType: m.document?.mime_type ?? "application/pdf",
        caption: m.document?.caption,
      };
    default:
      return { kind: "unsupported" };
  }
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload: string; text: string };
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; caption?: string };
}

interface MetaWebhook {
  object?: string;
  entry?: {
    id: string;
    changes?: {
      field: string;
      value?: {
        metadata?: { display_phone_number: string; phone_number_id: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: MetaMessage[];
        statuses?: {
          id: string;
          status: "sent" | "delivered" | "read" | "failed";
          timestamp: string;
          recipient_id: string;
          errors?: { code: number; title?: string }[];
          pricing?: { billable?: boolean; category?: string };
        }[];
      };
    }[];
  }[];
}

/** Test helper: builds the webhook body Meta would send for normalised events. */
export function toMetaWebhook(events: MessagingEvent[]): string {
  const byChannel = new Map<string, MessagingEvent[]>();
  for (const e of events) byChannel.set(e.channelId, [...(byChannel.get(e.channelId) ?? []), e]);
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [...byChannel.entries()].map(([channelId, list]) => ({
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "916512345678", phone_number_id: channelId },
            contacts: list.flatMap((e) =>
              e.type === "inbound_message"
                ? [{ wa_id: waNumber(e.from), profile: e.profileName ? { name: e.profileName } : {} }]
                : [],
            ),
            messages: list.flatMap((e) => (e.type === "inbound_message" ? [toMetaMessage(e)] : [])),
            statuses: list.flatMap((e) =>
              e.type === "status"
                ? [
                    {
                      id: e.providerMessageId,
                      status: e.status,
                      timestamp: String(e.at.getTime() / 1000),
                      recipient_id: "91",
                    },
                  ]
                : [],
            ),
          },
        },
      ],
    })),
  });
}

function toMetaMessage(e: Extract<MessagingEvent, { type: "inbound_message" }>): MetaMessage {
  const base = { from: waNumber(e.from), id: e.providerMessageId, timestamp: String(e.at.getTime() / 1000) };
  const c = e.content;
  switch (c.kind) {
    case "text":
      return { ...base, type: "text", text: { body: c.text } };
    case "button_reply":
      return {
        ...base,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: c.payload, title: c.title } },
      };
    case "audio":
      return { ...base, type: "audio", audio: { id: c.mediaId, mime_type: c.mimeType } };
    case "image":
      return {
        ...base,
        type: "image",
        image: { id: c.mediaId, mime_type: c.mimeType, ...(c.caption ? { caption: c.caption } : {}) },
      };
    case "document":
      return {
        ...base,
        type: "document",
        document: { id: c.mediaId, mime_type: c.mimeType, ...(c.caption ? { caption: c.caption } : {}) },
      };
    default:
      return { ...base, type: "unsupported" };
  }
}

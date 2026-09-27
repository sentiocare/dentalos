import { randomBytes } from "node:crypto";
import {
  FakeLLMProvider,
  FakeMessagingProvider,
  FakeSpeechProvider,
  type MessagingEvent,
} from "@dentalos/adapters";
import {
  connectWhatsApp,
  createClinic,
  getWhatsAppChannel,
  MemoryJobQueue,
  processOutbox,
} from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import { processInboundMessage } from "../whatsapp/inbound";
import { ingestMessagingEvents } from "../whatsapp/webhook";

/**
 * Plays a patient on WhatsApp against the real pipeline: webhook intake → job queue → assistant → outbox →
 * (fake) WhatsApp. Used by the acceptance tests and, from Phase 3, the conversation eval suite.
 */
export const CHANNEL_ID = "109876543210";

export async function setupWhatsAppClinic(pool: Pool, name = "Sharma Dental Clinic") {
  const key = randomBytes(32);
  const client = await pool.connect();
  let clinicId: string;
  try {
    await client.query("begin");
    ({ clinicId } = await createClinic(client, {
      name,
      city: "Ranchi",
      owner: { name: "Dr. Sharma", phone: "9835000001" },
    }));
    await client.query(
      "update clinics set address = 'Shop 12, Main Road, Lalpur, Ranchi', maps_url = 'https://maps.google.com/?q=Lalpur' where id = $1",
      [clinicId],
    );
    await client.query(
      "insert into doctors (clinic_id, name, phone, emergency_order) values ($1, 'Dr. Sharma', '+919835000001', 1)",
      [clinicId],
    );
    await client.query(
      "update procedure_types set price_min_paise = 350000, price_max_paise = 700000, price_public = true where clinic_id = $1 and code = 'rct_sitting'",
      [clinicId],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  await withClinic(pool, { clinicId, actor: "system", role: "owner" }, (c) =>
    connectWhatsApp(c, key, {
      phoneNumberId: CHANNEL_ID,
      displayPhone: "0651 2345678",
      accessToken: "token",
    }),
  );
  return { clinicId, key };
}

export class PatientSimulator {
  readonly messaging = new FakeMessagingProvider();
  readonly jobs = new MemoryJobQueue();
  readonly llm = new FakeLLMProvider();
  readonly voice = new FakeSpeechProvider();
  private seq = 0;

  constructor(
    private readonly pool: Pool,
    private readonly clinic: { clinicId: string; key: Buffer },
    readonly phone: string,
    public now: Date,
  ) {}

  private event(
    content: Extract<MessagingEvent, { type: "inbound_message" }>["content"],
    id?: string,
  ): MessagingEvent {
    const n = ++this.seq;
    return {
      type: "inbound_message",
      eventId: `msg:${id ?? `${this.phone}-${n}-${this.now.getTime()}`}`,
      providerMessageId: id ?? `wamid.${this.phone}.${n}.${this.now.getTime()}`,
      from: this.phone,
      channelId: CHANNEL_ID,
      at: this.now,
      content,
    };
  }

  /** Sends a message and returns everything the clinic sent back. */
  async say(text: string) {
    return this.deliver([this.event({ kind: "text", text })]);
  }

  async tap(payload: string, title = payload) {
    return this.deliver([this.event({ kind: "button_reply", payload, title })]);
  }

  async voiceNote(mediaId = "voice-1") {
    this.messaging.media.set(mediaId, { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" });
    return this.deliver([this.event({ kind: "audio", mediaId, mimeType: "audio/ogg" })]);
  }

  async deliver(events: MessagingEvent[]) {
    const before = this.messaging.sent.length;
    await ingestMessagingEvents(this.pool, this.jobs, events);
    await this.drain();
    return this.messaging.sent.slice(before);
  }

  /** Runs queued jobs the way the worker would. */
  async drain() {
    for (let guard = 0; guard < 50; guard++) {
      const inbound = this.jobs.take("process_inbound");
      const sends = this.jobs.take("send_outbox");
      if (inbound.length === 0 && sends.length === 0) return;
      for (const job of inbound) {
        await processInboundMessage(
          {
            pool: this.pool,
            jobs: this.jobs,
            llm: this.llm,
            voice: this.voice,
            messaging: this.messaging,
            channel: async (clinicId) =>
              withClinic(this.pool, { clinicId, actor: "system" }, (c) =>
                getWhatsAppChannel(c, this.clinic.key),
              ),
            now: () => this.now,
          },
          String(job.payload.clinicId),
          String(job.payload.messageId),
        );
      }
      for (const job of sends) {
        await withClinic(
          this.pool,
          { clinicId: String(job.payload.clinicId), actor: "system", role: "system" },
          (c) =>
            processOutbox(c, String(job.payload.outboxId), {
              messaging: this.messaging,
              channel: (cl) => getWhatsAppChannel(cl, this.clinic.key),
              now: () => this.now,
            }),
        );
      }
    }
  }

  /** All text the patient has received, oldest first. */
  transcript(): string[] {
    return this.messaging
      .to(this.phone)
      .map((m) => ("text" in m ? m.text : "body" in m ? m.body : "[template]"));
  }
}

export function lastButtons(sent: { kind: string; buttons?: { id: string; title: string }[] }[]) {
  return [...sent].reverse().find((m) => m.kind === "buttons")?.buttons ?? [];
}

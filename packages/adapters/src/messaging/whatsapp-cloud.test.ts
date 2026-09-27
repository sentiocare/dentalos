import { describe, expect, it } from "vitest";
import { hmacSha256Hex, ProviderError } from "../common";
import { messagingContract } from "../testing";
import { toMetaWebhook, WhatsAppCloudProvider } from "./whatsapp-cloud";

const APP_SECRET = "meta-app-secret";
const channel = { channelId: "109876543210", accessToken: "EAAG-test" };

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(responder: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = responder({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let counter = 0;
type Responder = (call: Call) => { status?: number; body: unknown };
const okResponder: Responder = () => ({
  body: { messaging_product: "whatsapp", messages: [{ id: `wamid.${++counter}` }] },
});

const provider = (responder: Responder = okResponder) => {
  const f = mockFetch(responder);
  return {
    provider: new WhatsAppCloudProvider({ appSecret: APP_SECRET, verifyToken: "verify-me", fetchImpl: f.fn }),
    calls: f.calls,
  };
};

const sign = (rawBody: string) => ({
  headers: { "x-hub-signature-256": `sha256=${hmacSha256Hex(APP_SECRET, rawBody)}` },
  rawBody,
});

messagingContract("whatsapp-cloud (mocked HTTP)", () => {
  const { provider: p } = provider();
  return { provider: p, signedWebhook: (events) => sign(toMetaWebhook(events)) };
});

describe("WhatsApp Cloud request format", () => {
  it("sends text to the clinic's phone number id without the + and with the clinic's token", async () => {
    const { provider: p, calls } = provider();
    await p.sendText(channel, { to: "+919876543210", text: "Namaste" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/109876543210/messages");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer EAAG-test");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "text",
      text: { body: "Namaste" },
    });
  });

  it("builds template components with body parameters and quick-reply payloads", async () => {
    const { provider: p, calls } = provider();
    await p.sendTemplate(channel, {
      to: "+919876543210",
      templateName: "appointment_reminder",
      language: "hi",
      bodyParams: ["Ramesh ji", "kal shaam 5 baje"],
      buttonPayloads: ["confirm:a1", "reschedule:a1"],
    });
    expect(JSON.parse(String(calls[0]!.init.body)).template).toEqual({
      name: "appointment_reminder",
      language: { code: "hi" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ramesh ji" },
            { type: "text", text: "kal shaam 5 baje" },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: "confirm:a1" }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "reschedule:a1" }],
        },
      ],
    });
  });

  it("classifies errors as retryable or not", async () => {
    const rateLimited = provider(() => ({
      status: 400,
      body: { error: { code: 131056, message: "pair rate limit" } },
    }));
    const e1 = await rateLimited.provider
      .sendText(channel, { to: "+919876543210", text: "x" })
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect((e1 as ProviderError).retryable).toBe(true);

    const outsideWindow = provider(() => ({
      status: 400,
      body: { error: { code: 131047, message: "Re-engagement message" } },
    }));
    const e2 = (await outsideWindow.provider
      .sendText(channel, { to: "+919876543210", text: "x" })
      .catch((e: unknown) => e)) as ProviderError;
    expect(e2.retryable).toBe(false);
    expect(e2.code).toBe("131047");

    const down = provider(() => ({ status: 503, body: {} }));
    expect(
      (
        (await down.provider
          .sendText(channel, { to: "+919876543210", text: "x" })
          .catch((e: unknown) => e)) as ProviderError
      ).retryable,
    ).toBe(true);
  });

  it("never puts phone numbers from Meta's error text into the error message", async () => {
    const p = provider(() => ({
      status: 400,
      body: { error: { code: 131026, message: "Recipient 919876543210 is not on WhatsApp" } },
    }));
    const e = (await p.provider
      .sendText(channel, { to: "+919876543210", text: "x" })
      .catch((err: unknown) => err)) as Error;
    expect(e.message).not.toContain("9876543210");
  });

  it("downloads voice notes in two steps with the token", async () => {
    const f = mockFetch(({ url }) =>
      url.endsWith("/media-1")
        ? { body: { url: "https://lookaside.fbsbx.com/x", mime_type: "audio/ogg" } }
        : { body: {} },
    );
    const p = new WhatsAppCloudProvider({ appSecret: APP_SECRET, verifyToken: "v", fetchImpl: f.fn });
    const media = await p.downloadMedia(channel, "media-1");
    expect(media.mimeType).toBe("audio/ogg");
    expect(f.calls[1]!.url).toBe("https://lookaside.fbsbx.com/x");
  });
});

describe("WhatsApp Cloud webhooks", () => {
  it("parses a real-shaped inbound payload: text, button reply, template button, voice note, status", () => {
    const { provider: p } = provider();
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "916512345678", phone_number_id: "109876543210" },
                contacts: [{ profile: { name: "Ramesh" }, wa_id: "919876543210" }],
                messages: [
                  {
                    from: "919876543210",
                    id: "wamid.A",
                    timestamp: "1790000000",
                    type: "text",
                    text: { body: "Sunday ko khula hai kya?" },
                  },
                  {
                    from: "919876543210",
                    id: "wamid.B",
                    timestamp: "1790000001",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "slot:h1", title: "Tue 5 PM" } },
                  },
                  {
                    from: "919876543210",
                    id: "wamid.C",
                    timestamp: "1790000002",
                    type: "button",
                    button: { payload: "confirm:a1", text: "Confirm" },
                  },
                  {
                    from: "919876543210",
                    id: "wamid.D",
                    timestamp: "1790000003",
                    type: "audio",
                    audio: { id: "media-9", mime_type: "audio/ogg; codecs=opus", voice: true },
                  },
                  {
                    from: "919876543210",
                    id: "wamid.E",
                    timestamp: "1790000004",
                    type: "sticker",
                    sticker: { id: "s" },
                  },
                ],
                statuses: [
                  {
                    id: "wamid.OUT",
                    status: "delivered",
                    timestamp: "1790000005",
                    recipient_id: "919876543210",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const events = p.parseWebhook(sign(raw));
    expect(events.map((e) => (e.type === "inbound_message" ? e.content.kind : e.status))).toEqual([
      "text",
      "button_reply",
      "button_reply",
      "audio",
      "unsupported",
      "delivered",
    ]);
    expect(events[0]).toMatchObject({
      from: "+919876543210",
      profileName: "Ramesh",
      channelId: "109876543210",
      eventId: "msg:wamid.A",
    });
    expect(events[2]).toMatchObject({ content: { payload: "confirm:a1" } });
  });

  it("answers Meta's subscription check only with the right verify token", () => {
    const { provider: p } = provider();
    expect(
      p.verifySubscription({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-me",
        "hub.challenge": "42",
      }),
    ).toBe("42");
    expect(
      p.verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42" }),
    ).toBeNull();
  });
});

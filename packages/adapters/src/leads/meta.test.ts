import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../common";
import { MetaLeadAdsProvider } from "./meta";

const config = { appSecret: "app-secret-for-tests", verifyToken: "verify-token-12345678" };
const sign = (raw: string) => ({
  headers: { "x-hub-signature-256": `sha256=${hmacSha256Hex(config.appSecret, raw)}` },
  rawBody: raw,
});

describe("Meta lead ads", () => {
  it("parses the Page leadgen webhook (ids only) and refuses bad signatures", () => {
    const p = new MetaLeadAdsProvider(config);
    const raw = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "444444444",
          time: 1790000000,
          changes: [
            {
              field: "leadgen",
              value: {
                ad_id: "120200000001",
                form_id: "900000001",
                leadgen_id: "1111111111",
                created_time: 1790000000,
                page_id: "444444444",
                adgroup_id: "120200000002",
              },
            },
            { field: "feed", value: { item: "status" } },
          ],
        },
      ],
    });
    expect(p.parseWebhook(sign(raw))).toEqual([
      {
        eventId: "leadgen:1111111111",
        leadgenId: "1111111111",
        pageId: "444444444",
        formId: "900000001",
        adId: "120200000001",
        createdAt: new Date(1790000000 * 1000),
      },
    ]);
    expect(() => p.parseWebhook({ headers: { "x-hub-signature-256": "sha256=00" }, rawBody: raw })).toThrow();
    expect(
      p.verifySubscription({
        "hub.mode": "subscribe",
        "hub.verify_token": config.verifyToken,
        "hub.challenge": "42",
      }),
    ).toBe("42");
    expect(
      p.verifySubscription({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token-00000000",
        "hub.challenge": "42",
      }),
    ).toBeNull();
  });

  it("fetches the answers with the Page token; an expired token is reported, not retried", async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization! });
      if ((init.headers as Record<string, string>).authorization === "Bearer expired")
        return new Response(
          JSON.stringify({ error: { code: 190, message: "Error validating access token" } }),
          { status: 400 },
        );
      return Response.json({
        created_time: "2030-08-01T10:15:30+0000",
        id: "1111111111",
        ad_name: "Braces - Ranchi",
        campaign_name: "Braces Aug",
        form_id: "900000001",
        platform: "ig",
        is_organic: false,
        field_data: [
          { name: "full_name", values: ["Priya Kumari"] },
          { name: "phone_number", values: ["+919876543210"] },
          { name: "what_treatment_are_you_looking_for?", values: ["braces"] },
        ],
      });
    }) as unknown as typeof fetch;
    const p = new MetaLeadAdsProvider({ ...config, fetchImpl });
    const lead = await p.fetchLead("page-token", "1111111111");
    expect(lead).toMatchObject({
      campaignName: "Braces Aug",
      platform: "ig",
      fields: [
        { name: "full_name", values: ["Priya Kumari"] },
        { name: "phone_number", values: ["+919876543210"] },
        { name: "what_treatment_are_you_looking_for?", values: ["braces"] },
      ],
    });
    expect(calls[0]!.url).toContain("/v23.0/1111111111?fields=created_time,field_data");
    expect(calls[0]!.auth).toBe("Bearer page-token");
    await expect(p.fetchLead("expired", "1")).rejects.toMatchObject({
      code: "token_invalid",
      retryable: false,
    });
  });

  it("sends lead outcomes to the dataset: form leads by lead id, WhatsApp-ad leads by click id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = new MetaLeadAdsProvider({
      ...config,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ events_received: 2 }), { status: 200 });
      }) as typeof fetch,
    });
    const at = new Date("2030-03-12T10:00:00Z");
    await p.sendConversions({
      datasetId: "777000111",
      accessToken: "capi-token",
      events: [
        {
          eventName: "booked",
          eventTime: at,
          eventId: "l1:booked",
          kind: "crm",
          leadId: "1111111111",
          hashedPhone: "ab",
        },
        {
          eventName: "Purchase",
          eventTime: at,
          eventId: "l2:won",
          kind: "whatsapp",
          ctwaClid: "ARAk",
          pageId: "444444444",
          valuePaise: 1_500_000,
        },
      ],
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/777000111/events");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer capi-token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: [
        {
          event_name: "booked",
          event_time: 1899540000,
          event_id: "l1:booked",
          action_source: "system_generated",
          user_data: { lead_id: "1111111111", ph: ["ab"] },
          custom_data: { event_source: "crm", lead_event_source: "Sentio Dental OS" },
        },
        {
          event_name: "Purchase",
          event_time: 1899540000,
          event_id: "l2:won",
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: { ctwa_clid: "ARAk", page_id: "444444444" },
          custom_data: { value: 15000, currency: "INR" },
        },
      ],
    });

    const refused = new MetaLeadAdsProvider({
      ...config,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 100, message: "Invalid dataset" } }), {
          status: 400,
        })) as unknown as typeof fetch,
    });
    await expect(
      refused.sendConversions({
        datasetId: "1",
        accessToken: "t",
        events: [{ eventName: "x", eventTime: at, eventId: "e", kind: "crm", leadId: "1" }],
      }),
    ).rejects.toMatchObject({ code: "http_400", retryable: false });
  });
});

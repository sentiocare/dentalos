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
});

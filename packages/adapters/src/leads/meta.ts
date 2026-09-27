import { hmacSha256Hex, ProviderError, safeEqualHex, type RawWebhook } from "../common";
import type { LeadAdsProvider, LeadDetails, LeadgenEvent } from "./types";

export interface MetaLeadAdsConfig {
  /** The same Meta app as WhatsApp: its secret signs the Page webhooks too. */
  appSecret: string;
  verifyToken: string;
  graphVersion?: string;
  graphBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Meta Lead Ads (https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving).
 * The Page webhook (object "page", field "leadgen") carries only ids; the answers come from
 * GET /{leadgen_id} with the clinic's long-lived Page access token.
 */
export class MetaLeadAdsProvider implements LeadAdsProvider {
  readonly name = "meta-lead-ads";
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: MetaLeadAdsConfig) {
    this.base = `${config.graphBaseUrl ?? "https://graph.facebook.com"}/${config.graphVersion ?? "v23.0"}`;
    this.fetch = config.fetchImpl ?? fetch;
  }

  verifySubscription(query: Record<string, string | undefined>): string | null {
    if (query["hub.mode"] !== "subscribe" || !query["hub.challenge"]) return null;
    const token = query["hub.verify_token"] ?? "";
    return token.length === this.config.verifyToken.length && safeEqualHex(token, this.config.verifyToken)
      ? query["hub.challenge"]
      : null;
  }

  verifyWebhook(webhook: RawWebhook): boolean {
    const header = webhook.headers["x-hub-signature-256"];
    if (!header?.startsWith("sha256=")) return false;
    return safeEqualHex(header.slice(7), hmacSha256Hex(this.config.appSecret, webhook.rawBody));
  }

  parseWebhook(webhook: RawWebhook): LeadgenEvent[] {
    if (!this.verifyWebhook(webhook))
      throw new ProviderError(this.name, "bad_signature", "Webhook signature invalid", false);
    const body = JSON.parse(webhook.rawBody) as {
      object?: string;
      entry?: {
        id: string;
        changes?: {
          field: string;
          value?: {
            leadgen_id?: string;
            page_id?: string;
            form_id?: string;
            ad_id?: string;
            created_time?: number;
          };
        }[];
      }[];
    };
    if (body.object !== "page") return [];
    const out: LeadgenEvent[] = [];
    for (const entry of body.entry ?? [])
      for (const change of entry.changes ?? []) {
        const v = change.value;
        if (change.field !== "leadgen" || !v?.leadgen_id) continue;
        out.push({
          eventId: `leadgen:${v.leadgen_id}`,
          leadgenId: v.leadgen_id,
          pageId: v.page_id ?? entry.id,
          formId: v.form_id,
          adId: v.ad_id,
          createdAt: new Date((v.created_time ?? Math.floor(Date.now() / 1000)) * 1000),
        });
      }
    return out;
  }

  async fetchLead(pageAccessToken: string, leadgenId: string): Promise<LeadDetails> {
    const fields = "created_time,field_data,ad_name,campaign_name,form_id,platform,is_organic";
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/${encodeURIComponent(leadgenId)}?fields=${fields}`, {
        headers: { authorization: `Bearer ${pageAccessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ProviderError(this.name, "network", String(error), true);
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: number; message?: string };
      created_time?: string;
      field_data?: { name: string; values: string[] }[];
      ad_name?: string;
      campaign_name?: string;
      form_id?: string;
      platform?: string;
      is_organic?: boolean;
    };
    if (!res.ok) {
      // 190: token expired or revoked; the clinic must reconnect its Page.
      const code = data.error?.code;
      throw new ProviderError(
        this.name,
        code === 190 ? "token_invalid" : `http_${res.status}`,
        "Could not fetch the lead from Meta",
        res.status >= 500 || res.status === 429,
      );
    }
    return {
      leadgenId,
      createdAt: data.created_time ? new Date(data.created_time) : new Date(),
      fields: (data.field_data ?? []).map((f) => ({ name: f.name, values: f.values ?? [] })),
      adName: data.ad_name,
      campaignName: data.campaign_name,
      formId: data.form_id,
      platform: data.platform,
      isOrganic: data.is_organic,
    };
  }

  async healthCheck() {
    return this.config.appSecret && this.config.verifyToken
      ? { ok: true }
      : { ok: false, detail: "Lead ads not configured" };
  }
}

import type { ProviderBase, RawWebhook } from "../common";

/**
 * Lead ads (Meta: Facebook and Instagram lead forms). Meta's webhook only says a lead exists; the answers are
 * fetched with the clinic's Page access token (permission leads_retrieval).
 */
export interface LeadAdsProvider extends ProviderBase {
  /** Meta's GET check when the webhook is set up; returns the challenge to echo, or null. */
  verifySubscription(query: Record<string, string | undefined>): string | null;
  verifyWebhook(webhook: RawWebhook): boolean;
  parseWebhook(webhook: RawWebhook): LeadgenEvent[];
  fetchLead(pageAccessToken: string, leadgenId: string): Promise<LeadDetails>;
  /**
   * Tells Meta what happened to leads after the ad (Conversions API: POST /{dataset_id}/events), so the ads
   * optimise for people who book and come rather than for form fills.
   */
  sendConversions(input: {
    datasetId: string;
    accessToken: string;
    events: ConversionEvent[];
  }): Promise<void>;
}

/**
 * One lead event for Meta. Form leads are matched by Meta's lead id ("system_generated", event_source "crm");
 * Click-to-WhatsApp leads by the ad click id ("business_messaging" on WhatsApp). Phones are SHA-256 hashed.
 */
export interface ConversionEvent {
  eventName: string;
  eventTime: Date;
  eventId: string;
  kind: "crm" | "whatsapp";
  leadId?: string;
  ctwaClid?: string;
  pageId?: string;
  hashedPhone?: string;
  valuePaise?: number;
}

export interface LeadgenEvent {
  eventId: string;
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  createdAt: Date;
}

export interface LeadDetails {
  leadgenId: string;
  createdAt: Date;
  /** The form's answers as asked: standard fields (full_name, phone_number, email, city) and custom questions. */
  fields: { name: string; values: string[] }[];
  adName?: string;
  campaignName?: string;
  formId?: string;
  platform?: string;
  isOrganic?: boolean;
}

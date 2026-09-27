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

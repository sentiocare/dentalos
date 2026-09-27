import { ProviderError, type RawWebhook } from "../common";
import { FakeSupport } from "../fake-support";
import type { LeadAdsProvider, LeadDetails, LeadgenEvent } from "./types";

export class FakeLeadAdsProvider implements LeadAdsProvider {
  readonly name = "fake-lead-ads";
  readonly support = new FakeSupport(this.name, "fake-leads-secret");
  /** Leads Meta would return, by leadgen id (tests put them here). */
  readonly leads = new Map<string, LeadDetails>();
  readonly fetched: { token: string; leadgenId: string }[] = [];

  verifySubscription(query: Record<string, string | undefined>) {
    return query["hub.verify_token"] === "fake-verify" ? (query["hub.challenge"] ?? null) : null;
  }

  verifyWebhook(webhook: RawWebhook) {
    return this.support.verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook) {
    return this.support.parseWebhook<LeadgenEvent>(webhook);
  }

  eventWebhook(events: LeadgenEvent[]) {
    return this.support.signWebhook(events);
  }

  async fetchLead(pageAccessToken: string, leadgenId: string) {
    this.support.throwIfScripted();
    this.fetched.push({ token: pageAccessToken, leadgenId });
    const lead = this.leads.get(leadgenId);
    if (!lead) throw new ProviderError(this.name, "not_found", "Lead not found", false);
    return lead;
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

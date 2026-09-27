import type { ProviderBase } from "../common";

/** DLT-registered SMS, used only as a fallback for critical alerts (TRAI rules apply). */
export interface SmsProvider extends ProviderBase {
  send(input: {
    to: string;
    text: string;
    dltTemplateId: string;
    senderId: string;
  }): Promise<{ providerMessageId: string }>;
}

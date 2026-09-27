import type { LLMProvider } from "./llm/types";
import type { MessagingProvider } from "./messaging/types";
import type { PaymentProvider } from "./payments/types";
import type { SmsProvider } from "./sms/types";
import type { StorageProvider } from "./storage/types";
import type { TelephonyProvider } from "./telephony/types";
import type { VoiceProvider } from "./voice/types";
import { FakeLLMProvider } from "./llm/fake";
import { FakeMessagingProvider } from "./messaging/fake";
import { FakePaymentProvider } from "./payments/fake";
import { FakeSmsProvider } from "./sms/fake";
import { FakeStorageProvider } from "./storage/fake";
import { FakeTelephonyProvider } from "./telephony/fake";
import { FakeVoiceProvider } from "./voice/fake";
import { WhatsAppCloudProvider, type WhatsAppCloudConfig } from "./messaging/whatsapp-cloud";

export interface Adapters {
  messaging: MessagingProvider;
  telephony: TelephonyProvider;
  voice: VoiceProvider;
  llm: LLMProvider;
  payments: PaymentProvider;
  sms: SmsProvider;
  storage: StorageProvider;
}

/**
 * Which implementation to use for each provider, chosen by environment variables
 * (e.g. MESSAGING_PROVIDER=whatsapp_cloud). Swapping a provider is a config change plus a new adapter.
 */
export interface AdapterSelection {
  messaging: "fake" | "whatsapp_cloud";
  telephony: "fake" | "exotel" | "plivo";
  voice: "fake" | "sarvam";
  llm: "fake" | "configured";
  payments: "fake" | "razorpay";
  sms: "fake" | "dlt";
  storage: "fake" | "supabase";
}

/** When each real adapter is built (PLAN §7). Until then, selecting it fails at startup, not mid-call. */
const PLANNED: Record<string, string> = {
  exotel: "Phase 3",
  plivo: "Phase 3",
  sarvam: "Phase 3",
  configured: "Phase 2",
  razorpay: "Phase 5",
  dlt: "Phase 2",
  supabase: "Phase 1",
};

function notYet(kind: string, choice: string): never {
  throw new Error(
    `${kind} provider "${choice}" is not built yet (planned for ${PLANNED[choice] ?? "later"}).`,
  );
}

/** Provider settings from the environment; each real adapter checks that its part is present. */
export interface AdapterOptions {
  whatsapp?: WhatsAppCloudConfig;
}

function required<T>(value: T | undefined, what: string): T {
  if (!value) throw new Error(`${what} is not configured (see docs/SETUP.md)`);
  return value;
}

export function createAdapters(selection: AdapterSelection, options: AdapterOptions = {}): Adapters {
  return {
    messaging:
      selection.messaging === "fake"
        ? new FakeMessagingProvider()
        : new WhatsAppCloudProvider(
            required(options.whatsapp, "WhatsApp (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN)"),
          ),
    telephony:
      selection.telephony === "fake" ? new FakeTelephonyProvider() : notYet("Telephony", selection.telephony),
    voice: selection.voice === "fake" ? new FakeVoiceProvider() : notYet("Voice", selection.voice),
    llm: selection.llm === "fake" ? new FakeLLMProvider() : notYet("LLM", selection.llm),
    payments:
      selection.payments === "fake" ? new FakePaymentProvider() : notYet("Payment", selection.payments),
    sms: selection.sms === "fake" ? new FakeSmsProvider() : notYet("SMS", selection.sms),
    storage: selection.storage === "fake" ? new FakeStorageProvider() : notYet("Storage", selection.storage),
  };
}

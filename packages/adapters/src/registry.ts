import type { LLMProvider } from "./llm/types";
import type { MessagingProvider } from "./messaging/types";
import type { PaymentProvider } from "./payments/types";
import type { SmsProvider } from "./sms/types";
import type { StorageProvider } from "./storage/types";
import type { TelephonyProvider } from "./telephony/types";
import type { SpeechProvider } from "./voice/types";
import { AnthropicLLMProvider, type AnthropicConfig } from "./llm/anthropic";
import { FakeLLMProvider } from "./llm/fake";
import { FakeMessagingProvider } from "./messaging/fake";
import { FakePaymentProvider } from "./payments/fake";
import { RazorpayPaymentProvider, type RazorpayConfig } from "./payments/razorpay";
import { FakeSmsProvider } from "./sms/fake";
import { FakeStorageProvider } from "./storage/fake";
import { SupabaseStorageProvider, type SupabaseStorageConfig } from "./storage/supabase";
import { FakeTelephonyProvider } from "./telephony/fake";
import { FakeSpeechProvider } from "./voice/fake";
import { SarvamSpeechProvider, type SarvamConfig } from "./voice/sarvam";
import { ExotelProvider, type ExotelConfig } from "./telephony/exotel";
import { WhatsAppCloudProvider, type WhatsAppCloudConfig } from "./messaging/whatsapp-cloud";

export interface Adapters {
  messaging: MessagingProvider;
  telephony: TelephonyProvider;
  /** Speech-to-text and text-to-speech for our own voice pipeline. */
  voice: SpeechProvider;
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
  telephony: "fake" | "exotel";
  voice: "fake" | "sarvam";
  llm: "fake" | "anthropic";
  payments: "fake" | "razorpay";
  sms: "fake" | "dlt";
  storage: "fake" | "supabase";
}

/** When each real adapter is built (PLAN §7). Until then, selecting it fails at startup, not mid-call. */
const PLANNED: Record<string, string> = {
  dlt: "Phase 2",
};

function notYet(kind: string, choice: string): never {
  throw new Error(
    `${kind} provider "${choice}" is not built yet (planned for ${PLANNED[choice] ?? "later"}).`,
  );
}

/** Provider settings from the environment; each real adapter checks that its part is present. */
export interface AdapterOptions {
  whatsapp?: WhatsAppCloudConfig;
  anthropic?: AnthropicConfig;
  sarvam?: SarvamConfig;
  supabaseStorage?: SupabaseStorageConfig;
  exotel?: ExotelConfig;
  razorpay?: RazorpayConfig;
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
      selection.telephony === "fake"
        ? new FakeTelephonyProvider()
        : new ExotelProvider(
            required(
              options.exotel,
              "Exotel (EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLBACK_TOKEN)",
            ),
          ),
    voice:
      selection.voice === "fake"
        ? new FakeSpeechProvider()
        : new SarvamSpeechProvider(required(options.sarvam, "Speech (SARVAM_API_KEY)")),
    llm:
      selection.llm === "fake"
        ? new FakeLLMProvider()
        : new AnthropicLLMProvider(required(options.anthropic, "LLM (ANTHROPIC_API_KEY)")),
    payments:
      selection.payments === "fake"
        ? new FakePaymentProvider()
        : new RazorpayPaymentProvider(
            required(
              options.razorpay,
              "Razorpay (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET)",
            ),
          ),
    sms: selection.sms === "fake" ? new FakeSmsProvider() : notYet("SMS", selection.sms),
    storage:
      selection.storage === "fake"
        ? new FakeStorageProvider()
        : new SupabaseStorageProvider(
            required(options.supabaseStorage, "Storage (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)"),
          ),
  };
}

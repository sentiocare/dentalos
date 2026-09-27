import { z } from "zod";
import type { AdapterOptions, AdapterSelection } from "./registry";

/** Provider settings shared by the API and the worker, read from environment variables. */
export const adapterEnvSchema = z.object({
  MESSAGING_PROVIDER: z.enum(["fake", "whatsapp_cloud"]).default("fake"),
  TELEPHONY_PROVIDER: z.enum(["fake", "exotel"]).default("fake"),
  VOICE_PROVIDER: z.enum(["fake", "sarvam"]).default("fake"),
  LLM_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-opus-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  PAYMENT_PROVIDER: z.enum(["fake", "razorpay"]).default("fake"),
  SMS_PROVIDER: z.enum(["fake", "dlt"]).default("fake"),
  STORAGE_PROVIDER: z.enum(["fake", "supabase"]).default("fake"),
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default("v23.0"),
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_STT_MODEL: z.string().default("saarika:v2.5"),
  SARVAM_TTS_MODEL: z.string().default("bulbul:v2"),
  SARVAM_TTS_SPEAKER: z.string().default("anushka"),
  EXOTEL_ACCOUNT_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_API_HOST: z.string().default("api.exotel.com"),
  /** Secret put in every Exotel flow URL as `key=` (openssl rand -hex 24). */
  EXOTEL_CALLBACK_TOKEN: z.string().min(16).optional(),
  /** 32 random bytes, base64 (openssl rand -base64 32). Encrypts clinics' provider credentials. */
  CHANNEL_SECRET_KEY: z.string().optional(),
});

export type AdapterEnv = z.infer<typeof adapterEnvSchema>;

export function adapterSelection(env: AdapterEnv): AdapterSelection {
  return {
    messaging: env.MESSAGING_PROVIDER,
    telephony: env.TELEPHONY_PROVIDER,
    voice: env.VOICE_PROVIDER,
    llm: env.LLM_PROVIDER,
    payments: env.PAYMENT_PROVIDER,
    sms: env.SMS_PROVIDER,
    storage: env.STORAGE_PROVIDER,
  };
}

export function adapterOptions(env: AdapterEnv): AdapterOptions {
  return {
    whatsapp:
      env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN
        ? {
            appSecret: env.WHATSAPP_APP_SECRET,
            verifyToken: env.WHATSAPP_VERIFY_TOKEN,
            graphVersion: env.WHATSAPP_GRAPH_VERSION,
          }
        : undefined,
    sarvam: env.SARVAM_API_KEY
      ? {
          apiKey: env.SARVAM_API_KEY,
          sttModel: env.SARVAM_STT_MODEL,
          ttsModel: env.SARVAM_TTS_MODEL,
          speaker: env.SARVAM_TTS_SPEAKER,
        }
      : undefined,
    exotel:
      env.EXOTEL_ACCOUNT_SID && env.EXOTEL_API_KEY && env.EXOTEL_API_TOKEN && env.EXOTEL_CALLBACK_TOKEN
        ? {
            accountSid: env.EXOTEL_ACCOUNT_SID,
            apiKey: env.EXOTEL_API_KEY,
            apiToken: env.EXOTEL_API_TOKEN,
            apiHost: env.EXOTEL_API_HOST,
            callbackToken: env.EXOTEL_CALLBACK_TOKEN,
          }
        : undefined,
    anthropic: env.ANTHROPIC_API_KEY
      ? { apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL, effort: env.LLM_EFFORT }
      : undefined,
  };
}

/** Production must never run on fakes; each real provider must have its settings. */
export function checkAdapterEnv(env: AdapterEnv, appEnv: string, ctx: z.RefinementCtx) {
  if (appEnv === "production") {
    for (const [key, value] of Object.entries(env)) {
      if (key.endsWith("_PROVIDER") && value === "fake") {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "fake providers are not allowed in production",
        });
      }
    }
  }
  if (env.MESSAGING_PROVIDER === "whatsapp_cloud") {
    if (!env.WHATSAPP_APP_SECRET)
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_APP_SECRET"], message: "required for WhatsApp" });
    if (!env.WHATSAPP_VERIFY_TOKEN)
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_VERIFY_TOKEN"], message: "required for WhatsApp" });
  }
  if (env.VOICE_PROVIDER === "sarvam" && !env.SARVAM_API_KEY)
    ctx.addIssue({ code: "custom", path: ["SARVAM_API_KEY"], message: "required for Sarvam speech" });
  if (env.TELEPHONY_PROVIDER === "exotel") {
    for (const key of [
      "EXOTEL_ACCOUNT_SID",
      "EXOTEL_API_KEY",
      "EXOTEL_API_TOKEN",
      "EXOTEL_CALLBACK_TOKEN",
    ] as const)
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required for Exotel" });
  }
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["ANTHROPIC_API_KEY"],
      message: "required for the anthropic LLM provider",
    });
  }
  if (appEnv === "production" || appEnv === "staging" || env.MESSAGING_PROVIDER !== "fake") {
    if (!env.CHANNEL_SECRET_KEY)
      ctx.addIssue({
        code: "custom",
        path: ["CHANNEL_SECRET_KEY"],
        message: "required (openssl rand -base64 32)",
      });
  }
}

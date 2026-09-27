import { loadEnv } from "@dentalos/shared";
import { z } from "zod";

export const configSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().url(),
    SENTRY_DSN: z.string().url().optional(),
    GIT_SHA: z.string().default(process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev"),
    MESSAGING_PROVIDER: z.enum(["fake", "whatsapp_cloud"]).default("fake"),
    TELEPHONY_PROVIDER: z.enum(["fake", "exotel", "plivo"]).default("fake"),
    VOICE_PROVIDER: z.enum(["fake", "sarvam"]).default("fake"),
    LLM_PROVIDER: z.enum(["fake", "configured"]).default("fake"),
    PAYMENT_PROVIDER: z.enum(["fake", "razorpay"]).default("fake"),
    SMS_PROVIDER: z.enum(["fake", "dlt"]).default("fake"),
    STORAGE_PROVIDER: z.enum(["fake", "supabase"]).default("fake"),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "production") return;
    for (const key of Object.keys(env) as (keyof typeof env)[]) {
      if (key.endsWith("_PROVIDER") && env[key] === "fake") {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "fake providers are not allowed in production",
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(configSchema, source);
}

export function adapterSelection(config: Config) {
  return {
    messaging: config.MESSAGING_PROVIDER,
    telephony: config.TELEPHONY_PROVIDER,
    voice: config.VOICE_PROVIDER,
    llm: config.LLM_PROVIDER,
    payments: config.PAYMENT_PROVIDER,
    sms: config.SMS_PROVIDER,
    storage: config.STORAGE_PROVIDER,
  };
}

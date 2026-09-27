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
    // Staff login tokens come from Supabase Auth. New projects publish signing keys at a JWKS URL,
    // e.g. https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json; older ones use a shared secret.
    AUTH_JWKS_URL: z.string().url().optional(),
    AUTH_JWT_SECRET: z.string().min(32).optional(),
    AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().default("authenticated"),
    // Local development and tests only: sign in with just a phone number.
    DEV_LOGIN: z.enum(["on", "off"]).default("off"),
    // Browser origins allowed to call the API (the staff dashboard), comma-separated.
    WEB_ORIGINS: z.string().default("http://localhost:3000"),
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
    if (!env.AUTH_JWKS_URL && !env.AUTH_JWT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_JWKS_URL"],
        message: "set AUTH_JWKS_URL or AUTH_JWT_SECRET",
      });
    }
    if (env.DEV_LOGIN === "on" && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_LOGIN"],
        message: "dev login is only for development and tests",
      });
    }
    if (env.DEV_LOGIN === "on" && !env.AUTH_JWT_SECRET) {
      ctx.addIssue({ code: "custom", path: ["AUTH_JWT_SECRET"], message: "dev login needs AUTH_JWT_SECRET" });
    }
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

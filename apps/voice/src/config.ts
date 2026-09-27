import { adapterEnvSchema, checkAdapterEnv } from "@dentalos/adapters";
import { loadEnv } from "@dentalos/shared";
import { z } from "zod";

export const configSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(8090),
    /** How long the assistant waits for an answer before asking "are you there?". */
    VOICE_NO_INPUT_MS: z.coerce.number().int().min(1000).default(7000),
    /** Say "one moment" when understanding takes longer than this. */
    VOICE_FILLER_AFTER_MS: z.coerce.number().int().min(300).default(1200),
    VOICE_MAX_CALL_MIN: z.coerce.number().int().min(1).max(60).default(15),
    /** The language model must answer quickly on a call, or the assistant carries on without it. */
    VOICE_LLM_TIMEOUT_MS: z.coerce.number().int().min(500).default(3500),
    GIT_SHA: z.string().default(process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev"),
  })
  .extend(adapterEnvSchema.shape)
  .superRefine((env, ctx) => checkAdapterEnv(env, env.APP_ENV, ctx))
  .superRefine((env, ctx) => {
    if (env.TELEPHONY_PROVIDER === "fake" && env.APP_ENV === "production")
      ctx.addIssue({ code: "custom", path: ["TELEPHONY_PROVIDER"], message: "required in production" });
  });

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (source: Record<string, string | undefined> = process.env): Config =>
  loadEnv(configSchema, source);

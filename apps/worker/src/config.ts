import { adapterEnvSchema, checkAdapterEnv } from "@dentalos/adapters";
import { loadEnv } from "@dentalos/shared";
import { z } from "zod";

export const configSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().url(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    GIT_SHA: z.string().default(process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev"),
  })
  .extend(adapterEnvSchema.shape)
  .superRefine((env, ctx) => checkAdapterEnv(env, env.APP_ENV, ctx));

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (source: Record<string, string | undefined> = process.env): Config =>
  loadEnv(configSchema, source);

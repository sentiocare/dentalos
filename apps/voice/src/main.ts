import { AnthropicLLMProvider, adapterOptions, adapterSelection, createAdapters } from "@dentalos/adapters";
import { createPool } from "@dentalos/db";
import { createLogger } from "@dentalos/shared/logger";
import { makeWorkerUtils } from "graphile-worker";
import { loadConfig } from "./config";
import { createVoiceServer } from "./server";
import { TtsCache } from "./tts-cache";

const config = loadConfig();
const logger = createLogger({ service: "voice", level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL, {
  onError: (err) => logger.warn({ err }, "idle database connection lost"),
});
const workerUtils = await makeWorkerUtils({ pgPool: pool });
const adapters = createAdapters(adapterSelection(config), adapterOptions(config));
// On a call the language model gets a short deadline and no retries: a late answer is worse than none.
const llm =
  config.LLM_PROVIDER === "anthropic" && config.ANTHROPIC_API_KEY
    ? new AnthropicLLMProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.LLM_MODEL,
        effort: config.LLM_EFFORT,
        timeoutMs: config.VOICE_LLM_TIMEOUT_MS,
        maxRetries: 0,
      })
    : adapters.llm;

const voice = createVoiceServer({
  pool,
  telephony: adapters.telephony,
  speech: adapters.voice,
  llm,
  jobs: {
    add: async (task, payload, options = {}) => {
      await workerUtils.addJob(task, payload, {
        jobKey: options.jobKey,
        runAt: options.runAt,
        queueName: options.queueName,
      });
    },
  },
  logger,
  ttsCache: new TtsCache(),
  noInputMs: config.VOICE_NO_INPUT_MS,
  fillerAfterMs: config.VOICE_FILLER_AFTER_MS,
  maxCallMs: config.VOICE_MAX_CALL_MIN * 60_000,
});

// Tells the API the voice service is up; if it stops, new calls ring the clinic's phone instead.
const beat = async () => {
  await pool
    .query(
      `insert into service_heartbeats (service, beat_at, detail) values ('voice', now(), $1)
       on conflict (service) do update set beat_at = now(), detail = excluded.detail`,
      [{ version: config.GIT_SHA, activeCalls: voice.sessions.size }],
    )
    .catch((err) => logger.warn({ err }, "voice heartbeat failed"));
};
await beat();
const heartbeat = setInterval(beat, 15_000);

voice.server.listen(config.PORT, "0.0.0.0", () =>
  logger.info({ port: config.PORT }, "voice service started"),
);

const shutdown = async () => {
  clearInterval(heartbeat);
  // Stop being chosen for new calls, give live calls a moment, then close.
  await pool.query("delete from service_heartbeats where service = 'voice'").catch(() => {});
  const deadline = Date.now() + 25_000;
  while (voice.sessions.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  await voice.close();
  await workerUtils.release();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

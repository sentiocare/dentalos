import { mkdirSync, writeFileSync } from "node:fs";
import { AnthropicLLMProvider, type LLMProvider } from "@dentalos/adapters";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupVoiceClinic } from "../../testing/voice-harness";
import { voiceEvalCases } from "./cases";
import { gatePasses, runEvalCase, STRICT, summarize, type EvalResult } from "./run";

/**
 * Runs every eval case against a fresh clinic. By default the language model is off (rules only), which is
 * how the assistant behaves when the model is slow or down, so it must pass on its own. Set
 * EVAL_LLM=anthropic (with ANTHROPIC_API_KEY) to run the same suite with the model.
 * A report is written to eval-results/voice-latest.json.
 */
const MONDAY = new Date("2030-01-07T09:00:00+05:30");

describe.skipIf(!hasTestDatabase)("phone assistant eval suite (Phase 3 gate)", () => {
  let db: TestDatabase;
  const results: EvalResult[] = [];
  const llm: LLMProvider | undefined =
    process.env.EVAL_LLM === "anthropic" && process.env.ANTHROPIC_API_KEY
      ? new AnthropicLLMProvider({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.LLM_MODEL,
          timeoutMs: 3500,
          maxRetries: 0,
        })
      : undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    await setupVoiceClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("has at least 200 cases, each with a unique id", () => {
    const cases = voiceEvalCases();
    expect(cases.length).toBeGreaterThanOrEqual(200);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("passes the gate: 100% on emergency, safety and never-invent; at least 95% overall", async () => {
    for (const c of voiceEvalCases()) results.push(await runEvalCase(db.pool, c, { now: MONDAY, llm }));
    const summary = summarize(results);
    mkdirSync("eval-results", { recursive: true });
    writeFileSync(
      "eval-results/voice-latest.json",
      JSON.stringify(
        { at: new Date().toISOString(), llm: llm ? "anthropic" : "rules only", summary, results },
        null,
        2,
      ),
    );
    const failed = results.filter((r) => !r.passed);
    const report = failed
      .map((r) => `${r.id} [${r.category}]: ${r.failures.join("; ")}\n  ${r.transcript.join("\n  ")}`)
      .join("\n\n");
    const strictFailures = failed.filter((r) => STRICT.includes(r.category));
    expect(strictFailures, report).toEqual([]);
    expect(gatePasses(summary), `${Math.round(summary.rate * 1000) / 10}% passed\n\n${report}`).toBe(true);
  }, 300_000);
});

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProviderError } from "../common";
import { AnthropicLLMProvider } from "./anthropic";

const Intent = z.object({ intent: z.enum(["book", "cancel", "other"]), procedure: z.string().nullable() });

function clientReturning(
  status: number,
  body: unknown,
  seen: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {},
) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.headers = new Headers(init.headers);
    seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new Anthropic({ apiKey: "test", fetch: fetchImpl, maxRetries: 0 });
}

const message = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 15 },
});

describe("AnthropicLLMProvider.extract", () => {
  it("sends a structured-output request with fallbacks, low effort and a cached system prompt", async () => {
    const seen: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {};
    const llm = new AnthropicLLMProvider({
      client: clientReturning(200, message('{"intent":"book","procedure":"rct"}'), seen),
    });
    const result = await llm.extract({
      system: "Classify",
      input: "RCT ke liye appointment chahiye",
      schema: Intent,
      maxTokens: 300,
      purpose: "nlu",
    });
    expect(result.data).toEqual({ intent: "book", procedure: "rct" });
    expect(seen.body).toMatchObject({
      model: "claude-opus-5",
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema" } },
      system: [{ type: "text", text: "Classify", cache_control: { type: "ephemeral" } }],
    });
    expect(seen.headers?.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("returns null data on refusal and on output that fails the schema", async () => {
    const refused = new AnthropicLLMProvider({ client: clientReturning(200, message("", "refusal")) });
    expect(
      (await refused.extract({ system: "s", input: "x", schema: Intent, maxTokens: 50, purpose: "nlu" }))
        .failure,
    ).toBe("refused");
    const invalid = new AnthropicLLMProvider({ client: clientReturning(200, message('{"intent":"dance"}')) });
    expect(
      (await invalid.extract({ system: "s", input: "x", schema: Intent, maxTokens: 50, purpose: "nlu" }))
        .failure,
    ).toBe("invalid_output");
  });

  it("maps API errors to retryable or permanent provider errors", async () => {
    const limited = new AnthropicLLMProvider({
      client: clientReturning(429, {
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
    });
    const e = (await limited
      .extract({ system: "s", input: "x", schema: Intent, maxTokens: 50, purpose: "nlu" })
      .catch((x: unknown) => x)) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.retryable).toBe(true);
    const bad = new AnthropicLLMProvider({
      client: clientReturning(401, { type: "error", error: { type: "authentication_error", message: "no" } }),
    });
    expect(
      (
        (await bad
          .extract({ system: "s", input: "x", schema: Intent, maxTokens: 50, purpose: "nlu" })
          .catch((x: unknown) => x)) as ProviderError
      ).retryable,
    ).toBe(false);
  });
});

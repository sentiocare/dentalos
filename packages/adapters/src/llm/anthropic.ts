import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ProviderError, type HealthStatus } from "../common";
import type { ExtractRequest, ExtractResult, LLMProvider, LLMRequest, LLMResponse } from "./types";

/**
 * Claude via the official Anthropic SDK.
 *
 * - Default model claude-opus-5 (configurable: LLM_MODEL).
 * - Low effort by default: the assistant uses the model for short classification/extraction, where low
 *   effort keeps latency and cost down without losing quality; raise LLM_EFFORT if evals show a need.
 * - Server-side refusal fallbacks ("default" routing) so a declined request is retried on another model.
 * - Structured outputs (output_config.format) for extraction, validated again with Zod here.
 * - Tight timeout with one retry: WhatsApp and voice replies must stay quick; on failure the assistant
 *   falls back to its rule-based understanding.
 */
export interface AnthropicConfig {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  maxRetries?: number;
  client?: Anthropic;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicLLMProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<AnthropicConfig["effort"]>;

  constructor(config: AnthropicConfig = {}) {
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey,
        timeout: config.timeoutMs ?? 15_000,
        maxRetries: config.maxRetries ?? 1,
      });
    this.model = config.model ?? "claude-opus-5";
    this.effort = config.effort ?? "low";
  }

  private wrap(error: unknown): never {
    if (error instanceof Anthropic.RateLimitError)
      throw new ProviderError(this.name, "429", "LLM rate limited", true);
    if (error instanceof Anthropic.AuthenticationError)
      throw new ProviderError(this.name, "401", "LLM key rejected", false);
    if (error instanceof Anthropic.BadRequestError)
      throw new ProviderError(this.name, "400", "LLM request rejected", false);
    if (error instanceof Anthropic.APIConnectionError)
      throw new ProviderError(this.name, "network", "LLM unreachable", true);
    if (error instanceof Anthropic.APIError) {
      throw new ProviderError(
        this.name,
        String(error.status ?? "error"),
        "LLM error",
        (error.status ?? 500) >= 500,
      );
    }
    throw error;
  }

  async extract<T>(request: ExtractRequest<T>): Promise<ExtractResult<T>> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.input }],
        output_config: {
          effort: this.effort,
          format: {
            type: "json_schema",
            schema: z.toJSONSchema(request.schema, { target: "draft-7" }) as Record<string, unknown>,
          },
        },
      });
    } catch (error) {
      this.wrap(error);
    }
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === "refusal")
      return { data: null, model: response.model, usage, failure: "refused" };
    if (response.stop_reason === "max_tokens")
      return { data: null, model: response.model, usage, failure: "truncated" };
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      const parsed = request.schema.safeParse(JSON.parse(text));
      return parsed.success
        ? { data: parsed.data, model: response.model, usage }
        : { data: null, model: response.model, usage, failure: "invalid_output" };
    } catch {
      return { data: null, model: response.model, usage, failure: "invalid_output" };
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map((m) => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "tool")
        return {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
        };
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({
            type: "tool_use" as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
      };
    });
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages,
        tools: request.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        })),
        output_config: { effort: this.effort },
      });
    } catch (error) {
      this.wrap(error);
    }
    return {
      text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      toolCalls: response.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input as Record<string, unknown> }] : [],
      ),
      stopReason:
        response.stop_reason === "tool_use"
          ? "tool_use"
          : response.stop_reason === "max_tokens"
            ? "max_tokens"
            : "end",
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true };
  }
}

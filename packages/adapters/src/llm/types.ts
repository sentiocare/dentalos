import type { z } from "zod";
import type { ProviderBase } from "../common";

/** Text LLM for WhatsApp replies, summaries and intent classification. Model choice is configuration. */
export interface LLMProvider extends ProviderBase {
  complete(request: LLMRequest): Promise<LLMResponse>;
  /**
   * Structured extraction: the model must answer with JSON matching the schema. Returns null data when
   * the model declines or the output does not validate; callers fall back to rule-based handling.
   */
  extract<T>(request: ExtractRequest<T>): Promise<ExtractResult<T>>;
}

export interface ExtractRequest<T> {
  /** Stable instructions (cached by providers that support prompt caching). */
  system: string;
  /** The varying input, e.g. the patient's message and short context. */
  input: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  purpose: string;
}

export interface ExtractResult<T> {
  data: T | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Why data is null, for logs and evals. */
  failure?: "refused" | "invalid_output" | "truncated";
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input (generated from the shared Zod schema). */
  inputSchema: Record<string, unknown>;
}

export type LLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LLMToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  maxTokens: number;
  temperature?: number;
  /** Purpose label for metering and eval reports, e.g. "whatsapp_reply", "call_summary". */
  purpose: string;
}

export interface LLMResponse {
  text: string;
  toolCalls: LLMToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens";
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

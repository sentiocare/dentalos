import { FakeSupport } from "../fake-support";
import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export type ScriptedResponder = (request: LLMRequest) => Partial<LLMResponse> & { text?: string };

/**
 * Deterministic LLM for unit tests. Evals use a real provider; this fake is for testing the code around it.
 */
export class FakeLLMProvider implements LLMProvider {
  readonly name = "fake-llm";
  readonly support = new FakeSupport(this.name, "unused");
  readonly requests: LLMRequest[] = [];

  constructor(private responder: ScriptedResponder = () => ({ text: "ok" })) {}

  respondWith(responder: ScriptedResponder): void {
    this.responder = responder;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.support.throwIfScripted();
    this.requests.push(request);
    const partial = this.responder(request);
    const toolCalls = partial.toolCalls ?? [];
    return {
      text: partial.text ?? "",
      toolCalls,
      stopReason: partial.stopReason ?? (toolCalls.length ? "tool_use" : "end"),
      model: partial.model ?? "fake-model",
      usage: partial.usage ?? {
        inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
        outputTokens: Math.ceil((partial.text ?? "").length / 4),
      },
    };
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

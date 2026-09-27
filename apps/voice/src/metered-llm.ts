import type { ExtractRequest, LLMProvider, LLMRequest } from "@dentalos/adapters";

/** Counts the tokens one call uses, for the per-call cost shown to the clinic. */
export function meteredLLM(
  llm: LLMProvider,
  usage: { llmInputTokens: number; llmOutputTokens: number },
): LLMProvider {
  return {
    name: llm.name,
    healthCheck: () => llm.healthCheck(),
    async complete(request: LLMRequest) {
      const res = await llm.complete(request);
      usage.llmInputTokens += res.usage.inputTokens;
      usage.llmOutputTokens += res.usage.outputTokens;
      return res;
    },
    async extract<T>(request: ExtractRequest<T>) {
      const res = await llm.extract(request);
      usage.llmInputTokens += res.usage.inputTokens;
      usage.llmOutputTokens += res.usage.outputTokens;
      return res;
    },
  };
}

import { describe, expect, it } from "vitest";
import { ProviderError } from "./common.js";
import {
  createAdapters,
  FakeLLMProvider,
  FakeMessagingProvider,
  FakePaymentProvider,
  FakeSmsProvider,
  FakeStorageProvider,
  FakeTelephonyProvider,
  FakeVoiceProvider,
} from "./index.js";
import { messagingContract, paymentContract, storageContract, telephonyContract } from "./testing.js";

messagingContract("fake", () => {
  const provider = new FakeMessagingProvider();
  return { provider, signedWebhook: (events) => provider.inboundWebhook(events) };
});

telephonyContract("fake", () => {
  const provider = new FakeTelephonyProvider();
  provider.answeringNumbers.add("+919811111111");
  return {
    provider,
    signedWebhook: (events) => provider.eventWebhook(events),
    answeringNumber: "+919811111111",
  };
});

paymentContract("fake", () => {
  const provider = new FakePaymentProvider();
  return {
    provider,
    signedWebhook: (events) => provider.eventWebhook(events),
    activeMandateId: (max) => provider.activateMandate(max),
  };
});

storageContract("fake", () => ({ provider: new FakeStorageProvider() }));

describe("fake failure scripting", () => {
  it("throws a scripted ProviderError once, with the retryable flag", async () => {
    const provider = new FakeMessagingProvider();
    provider.support.failNext("rate_limited", true);
    const error = await provider.sendText({ to: "+919876543210", text: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    await expect(provider.sendText({ to: "+919876543210", text: "hi" })).resolves.toBeTruthy();
    expect(provider.sent).toHaveLength(1);
  });

  it("reports unhealthy when told to", async () => {
    const voice = new FakeVoiceProvider();
    voice.support.healthy = false;
    expect((await voice.healthCheck()).ok).toBe(false);
  });
});

describe("other fakes", () => {
  it("SMS requires a DLT template id", async () => {
    const sms = new FakeSmsProvider();
    await expect(
      sms.send({ to: "+919876543210", text: "x", dltTemplateId: "", senderId: "SNTIO" }),
    ).rejects.toThrow();
  });

  it("LLM fake returns scripted tool calls", async () => {
    const llm = new FakeLLMProvider(() => ({
      toolCalls: [{ id: "t1", name: "get_price_range", input: { procedure: "RCT" } }],
    }));
    const res = await llm.complete({
      system: "s",
      messages: [{ role: "user", content: "RCT kitna ka hai" }],
      maxTokens: 100,
      purpose: "test",
    });
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls[0]?.name).toBe("get_price_range");
  });

  it("voice fake declares the safety capabilities the call flow requires", () => {
    const voice = new FakeVoiceProvider();
    expect(voice.capabilities.responseInterception).toBe(true);
  });
});

describe("createAdapters", () => {
  it("builds all fakes", () => {
    const adapters = createAdapters({
      messaging: "fake",
      telephony: "fake",
      voice: "fake",
      llm: "fake",
      payments: "fake",
      sms: "fake",
      storage: "fake",
    });
    expect(Object.keys(adapters)).toHaveLength(7);
  });

  it("fails fast, naming the phase, for adapters not built yet", () => {
    expect(() =>
      createAdapters({
        messaging: "whatsapp_cloud",
        telephony: "fake",
        voice: "fake",
        llm: "fake",
        payments: "fake",
        sms: "fake",
        storage: "fake",
      }),
    ).toThrow(/Phase 2/);
  });
});

import { describe, expect, it } from "vitest";
import { ProviderError } from "./common";
import {
  createAdapters,
  FakeLLMProvider,
  FakeMessagingProvider,
  FakePaymentProvider,
  FakeSmsProvider,
  FakeStorageProvider,
  FakeTelephonyProvider,
  FakeSpeechProvider,
} from "./index";
import {
  messagingContract,
  paymentContract,
  speechContract,
  storageContract,
  telephonyContract,
} from "./testing";

messagingContract("fake", () => {
  const provider = new FakeMessagingProvider();
  return { provider, signedWebhook: (events) => provider.inboundWebhook(events) };
});

telephonyContract("fake", () => {
  const provider = new FakeTelephonyProvider();
  return { provider, callbackToken: provider.callbackToken };
});

speechContract("fake", () => ({ provider: new FakeSpeechProvider() }));

paymentContract("fake", () => {
  const provider = new FakePaymentProvider();
  return {
    provider,
    signedWebhook: (events, account) => provider.eventWebhook(events, account),
    activeMandateId: (max) => provider.activateMandate(max),
  };
});

storageContract("fake", () => ({ provider: new FakeStorageProvider() }));

describe("fake failure scripting", () => {
  it("throws a scripted ProviderError once, with the retryable flag", async () => {
    const provider = new FakeMessagingProvider();
    provider.support.failNext("rate_limited", true);
    const ch = { channelId: "1", accessToken: "t" };
    const error = await provider.sendText(ch, { to: "+919876543210", text: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    await expect(provider.sendText(ch, { to: "+919876543210", text: "hi" })).resolves.toBeTruthy();
    expect(provider.sent).toHaveLength(1);
  });

  it("reports unhealthy when told to", async () => {
    const voice = new FakeSpeechProvider();
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

  it("fake speech carries its text through the audio", async () => {
    const voice = new FakeSpeechProvider();
    const { pcm } = await voice.synthesize({
      text: "mujhe kal appointment chahiye",
      language: "hi-IN",
      sampleRate: 8000,
    });
    const padded = Buffer.concat([Buffer.alloc(3200), Buffer.from(pcm), Buffer.alloc(1600)]);
    const heard = await voice.transcribe({
      format: "pcm16",
      audio: new Uint8Array(padded),
      sampleRate: 8000,
    });
    expect(heard.text).toBe("mujhe kal appointment chahiye");
    expect(
      (await voice.transcribe({ format: "pcm16", audio: new Uint8Array(3200), sampleRate: 8000 })).text,
    ).toBe("");
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

  it("fails fast when a real adapter is chosen without its settings", () => {
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
    ).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it("fails fast, naming the phase, for adapters not built yet", () => {
    expect(() =>
      createAdapters({
        messaging: "fake",
        telephony: "fake",
        voice: "fake",
        llm: "fake",
        payments: "fake",
        sms: "dlt",
        storage: "fake",
      }),
    ).toThrow(/Phase 2/);
  });
});

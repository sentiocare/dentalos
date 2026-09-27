import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, resample, rms, silence } from "../audio";
import { ProviderError } from "../common";
import { speechContract } from "../testing";
import { SarvamSpeechProvider } from "./sarvam";

/** A fake Sarvam API: records requests, returns a transcript and a 16 kHz WAV of a tone. */
function fakeSarvam(options: { status?: number } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const tone = new Int16Array(16000 / 4).map((_, i) => Math.round(8000 * Math.sin(i / 5)));
  const wav = encodeWav(new Uint8Array(tone.buffer), 16000);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (options.status)
      return new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: options.status });
    if (url.endsWith("/speech-to-text"))
      return Response.json({
        request_id: "r1",
        transcript: " कल शाम को आ सकता हूँ ",
        language_code: "hi-IN",
      });
    return Response.json({ request_id: "r2", audios: [Buffer.from(wav).toString("base64")] });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

speechContract("sarvam (recorded API shapes)", () => ({
  provider: new SarvamSpeechProvider({ apiKey: "k", fetchImpl: fakeSarvam().fetchImpl }),
}));

describe("Sarvam speech adapter", () => {
  it("sends telephony audio as a WAV file with the model and auto language", async () => {
    const api = fakeSarvam();
    const sarvam = new SarvamSpeechProvider({
      apiKey: "secret-key",
      fetchImpl: api.fetchImpl,
      sttModel: "saarika:v2.5",
    });
    const heard = await sarvam.transcribe({
      format: "pcm16",
      audio: silence(1000),
      sampleRate: 8000,
      language: "auto",
    });
    expect(heard).toEqual({ text: "कल शाम को आ सकता हूँ", language: "hi-IN", audioMs: 1000 });
    const { url, init } = api.requests[0]!;
    expect(url).toBe("https://api.sarvam.ai/speech-to-text");
    expect((init.headers as Record<string, string>)["api-subscription-key"]).toBe("secret-key");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("saarika:v2.5");
    expect(form.get("language_code")).toBe("unknown");
    const file = form.get("file") as Blob;
    const wav = decodeWav(new Uint8Array(await file.arrayBuffer()));
    expect(wav.sampleRate).toBe(8000);
    expect(wav.pcm.byteLength).toBe(16000);
  });

  it("asks for speech at the telephony rate and resamples if needed", async () => {
    const api = fakeSarvam();
    const sarvam = new SarvamSpeechProvider({ apiKey: "k", fetchImpl: api.fetchImpl, speaker: "anushka" });
    const out = await sarvam.synthesize({ text: "Namaste", language: "hi-IN", sampleRate: 8000 });
    const body = JSON.parse(api.requests[0]!.init.body as string);
    expect(body).toMatchObject({
      text: "Namaste",
      target_language_code: "hi-IN",
      speaker: "anushka",
      speech_sample_rate: 8000,
    });
    // The fake returned 16 kHz; the adapter converts to 8 kHz (half the samples).
    expect(out.pcm.byteLength).toBe(4000);
    expect(rms(out.pcm)).toBeGreaterThan(1000);
  });

  it("marks rate limits and server errors as retryable", async () => {
    const sarvam = new SarvamSpeechProvider({
      apiKey: "k",
      fetchImpl: fakeSarvam({ status: 429 }).fetchImpl,
    });
    const error = await sarvam.synthesize({ text: "x", language: "en-IN", sampleRate: 8000 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    const bad = new SarvamSpeechProvider({ apiKey: "k", fetchImpl: fakeSarvam({ status: 401 }).fetchImpl });
    expect(
      (await bad.synthesize({ text: "x", language: "en-IN", sampleRate: 8000 }).catch((e) => e)).retryable,
    ).toBe(false);
  });
});

describe("audio helpers", () => {
  it("WAV round trip and resampling keep duration", () => {
    const pcm = new Uint8Array(new Int16Array([1, -2, 3, -4, 5, -6, 7, -8]).buffer);
    expect(decodeWav(encodeWav(pcm, 8000))).toEqual({ pcm, sampleRate: 8000 });
    expect(resample(silence(1000, 8000), 8000, 16000).byteLength).toBe(32000);
    expect(() => decodeWav(new Uint8Array(20))).toThrow();
  });
});

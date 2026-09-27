import { describe, expect, it } from "vitest";
import { telephonyContract } from "../testing";
import { ExotelProvider, exotelStreamCodec } from "./exotel";

const token = "exotel-callback-token-0123456789";
telephonyContract("exotel", () => ({
  provider: new ExotelProvider({ accountSid: "sentio", apiKey: "k", apiToken: "t", callbackToken: token }),
  callbackToken: token,
}));

describe("Exotel media stream", () => {
  it("reads Exotel's start, media, dtmf, mark and stop messages", () => {
    const start = exotelStreamCodec.parse(
      JSON.stringify({
        event: "start",
        sequence_number: 1,
        stream_sid: "st1",
        start: {
          stream_sid: "st1",
          call_sid: "ca1",
          account_sid: "sentio",
          from: "09876543210",
          to: "08047112233",
          custom_parameters: { clinic: "x" },
          media_format: { encoding: "base64", sample_rate: "8000", bit_rate: "128kbps" },
        },
      }),
    );
    expect(start).toEqual({
      type: "start",
      streamId: "st1",
      providerCallId: "ca1",
      from: "+919876543210",
      to: "+918047112233",
      sampleRate: 8000,
      params: { clinic: "x" },
    });
    const media = exotelStreamCodec.parse(
      JSON.stringify({
        event: "media",
        stream_sid: "st1",
        media: { chunk: 2, timestamp: "40", payload: Buffer.from([1, 0, 2, 0]).toString("base64") },
      }),
    );
    expect(media).toEqual({ type: "audio", pcm: new Uint8Array([1, 0, 2, 0]) });
    expect(
      exotelStreamCodec.parse(JSON.stringify({ event: "dtmf", dtmf: { digit: "1", duration: "100" } })),
    ).toEqual({ type: "dtmf", digit: "1" });
    expect(exotelStreamCodec.parse(JSON.stringify({ event: "stop", stop: { reason: "callended" } }))).toEqual(
      { type: "stop", reason: "callended" },
    );
    expect(exotelStreamCodec.parse("not json")).toEqual({ type: "unknown" });
  });

  it("sends audio in 3,200-byte chunks (multiples of 320 bytes)", () => {
    const frames = exotelStreamCodec.audio("st1", new Uint8Array(7000));
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      const m = JSON.parse(f);
      expect(m).toMatchObject({ event: "media", stream_sid: "st1" });
      expect(Buffer.from(m.media.payload, "base64").byteLength).toBe(3200);
    }
  });

  it("answers the Connect applet with national numbers in ring order", () => {
    const exotel = new ExotelProvider({ accountSid: "s", apiKey: "k", apiToken: "t", callbackToken: token });
    const res = exotel.flowResponse({
      kind: "connect",
      numbers: ["+919811111111"],
      ringSeconds: 25,
      record: true,
      whisper: "Emergency call",
    });
    expect(JSON.parse(res.body)).toMatchObject({
      destination: { numbers: ["09811111111"] },
      max_ringing_duration: 25,
      record: true,
      start_call_playback: { type: "text", value: "Emergency call" },
    });
  });

  it("places outbound calls through the flow with basic auth", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const exotel = new ExotelProvider({
      accountSid: "sentio",
      apiKey: "key",
      apiToken: "tok",
      apiHost: "api.in.exotel.com",
      callbackToken: token,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ Call: { Sid: "ca9" } });
      }) as unknown as typeof fetch,
    });
    await expect(
      exotel.placeCall({ to: "+919876543210", callerId: "+918047112233", flowId: "123" }),
    ).resolves.toEqual({ providerCallId: "ca9" });
    expect(calls[0]!.url).toBe("https://api.in.exotel.com/v1/Accounts/sentio/Calls/connect.json");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("From")).toBe("09876543210");
    expect(body.get("Url")).toBe("http://my.exotel.com/sentio/exoml/start_voice/123");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("key:tok").toString("base64")}`,
    );
  });
});

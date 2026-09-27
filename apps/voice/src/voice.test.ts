import type { AddressInfo } from "node:net";
import {
  chunk,
  concatBytes,
  decodeFakeSpeech,
  exotelStreamCodec,
  FakeLLMProvider,
  FakeSpeechProvider,
  FakeTelephonyProvider,
  fakeSpeechAudio,
  silence,
} from "@dentalos/adapters";
import { routeInboundCall } from "@dentalos/agent";
import { setupVoiceClinic, VOICE_NUMBER } from "@dentalos/agent/testing";
import { createPatient, MemoryJobQueue } from "@dentalos/core";
import { withClinic } from "@dentalos/db";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createVoiceServer, type VoiceServer } from "./server";
import { TtsCache } from "./tts-cache";

/**
 * The voice service end to end with real audio framing: a fake Exotel sends the caller's "speech" (fake
 * speech audio that carries its words) over the media WebSocket; we check what comes back as audio, what
 * is stored, and timing behaviour (barge-in, silence, filler, latency).
 */
const MONDAY_9AM = new Date("2030-01-07T09:00:00+05:30");

class FakeExotelCall {
  readonly ws: WebSocket;
  private audio: Uint8Array[] = [];
  readonly events: Record<string, unknown>[] = [];
  readonly marks: string[] = [];
  autoAck = true;
  closed: Promise<number>;
  isClosed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closed = new Promise((resolve) =>
      this.ws.on("close", (code) => {
        this.isClosed = true;
        resolve(code);
      }),
    );
    this.ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      this.events.push(m);
      const e = exotelStreamCodec.parse(data.toString());
      if (e.type === "audio") this.audio.push(e.pcm);
      if (m.event === "mark") {
        this.marks.push(m.mark.name);
        if (this.autoAck) this.ack(m.mark.name);
      }
    });
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  ack(name: string) {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ event: "mark", stream_sid: "st1", mark: { name } }));
  }

  start(callSid: string, from: string) {
    this.ws.send(JSON.stringify({ event: "connected" }));
    this.ws.send(
      JSON.stringify({
        event: "start",
        stream_sid: "st1",
        start: {
          stream_sid: "st1",
          call_sid: callSid,
          from,
          to: VOICE_NUMBER,
          media_format: { sample_rate: "8000" },
        },
      }),
    );
  }

  sendAudio(pcm: Uint8Array) {
    for (const c of chunk(pcm, 320))
      this.ws.send(
        JSON.stringify({
          event: "media",
          stream_sid: "st1",
          media: { payload: Buffer.from(c).toString("base64") },
        }),
      );
  }

  /** Says something, then goes quiet long enough for the end of the turn to be detected. */
  speak(text: string) {
    this.sendAudio(concatBytes([silence(200), fakeSpeechAudio(text), silence(1200)]));
  }

  /** Everything the assistant has said so far, decoded from the audio. */
  heard(): string {
    return decodeFakeSpeech(concatBytes(this.audio)) ?? "";
  }

  async waitFor(pattern: RegExp, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (pattern.test(this.heard())) return this.heard();
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${pattern}; heard: ${this.heard()}`);
  }

  cleared() {
    return this.events.filter((e) => e.event === "clear").length;
  }
}

describe.skipIf(!hasTestDatabase)("voice service (media stream, audio pipeline)", () => {
  let db: TestDatabase;
  let clinicId: string;
  let voice: VoiceServer;
  let url: string;
  const telephony = new FakeTelephonyProvider();
  const speech = new FakeSpeechProvider();
  const jobs = new MemoryJobQueue();
  let n = 0;
  const phone = () => `+9192000${String(10000 + ++n)}`;

  beforeAll(async () => {
    db = await createTestDatabase({ max: 25 });
    ({ clinicId } = await setupVoiceClinic(db.pool));
    voice = createVoiceServer({
      pool: db.pool,
      telephony,
      speech,
      llm: new FakeLLMProvider(),
      jobs,
      logger: createLogger({ service: "voice-test", level: "fatal" }),
      ttsCache: new TtsCache(),
      noInputMs: 400,
      fillerAfterMs: 150,
      maxCallMs: 60_000,
      now: () => new Date(MONDAY_9AM),
    });
    await new Promise<void>((resolve) => voice.server.listen(0, "127.0.0.1", () => resolve()));
    const port = (voice.server.address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/media?key=${telephony.callbackToken}`;
  });
  afterAll(async () => {
    await voice?.close();
    await db?.drop();
  });

  /** What Exotel does: the routing request first, then the media stream. */
  async function dial(from = phone(), options: { autoAck?: boolean } = {}) {
    const callSid = `CA${Date.now()}${++n}`;
    const routed = await routeInboundCall(
      db.pool,
      { provider: telephony.name, providerCallId: callSid, from, to: VOICE_NUMBER },
      { voiceHealthy: true, now: MONDAY_9AM },
    );
    expect(routed?.route).toBe("assistant");
    const call = new FakeExotelCall(url);
    call.autoAck = options.autoAck ?? true;
    await call.opened();
    call.start(callSid, from.replace("+91", "0"));
    return { call, callId: routed!.callId, from };
  }
  const record = async (callId: string) =>
    (await db.pool.query("select * from calls where id = $1", [callId])).rows[0];

  it("books an appointment by voice, end to end, and hangs up when the caller is done", async () => {
    const from = phone();
    await withClinic(db.pool, { clinicId, actor: "system", role: "owner" }, (c) =>
      createPatient(c, { name: "Sunita Devi", phone: from, source: "staff" }),
    );
    const { call, callId } = await dial(from);
    await call.waitFor(/रिकॉर्ड .* मदद कर सकती हूँ/);

    call.speak("मुझे कल शाम को चेकअप के लिए आना है");
    await call.waitFor(/Sunita Devi के लिए है/);
    call.speak("हाँ जी");
    await call.waitFor(/कौन-सा ठीक रहेगा/);
    call.speak("पहला वाला");
    await call.waitFor(/बुक कर दूँ/);
    call.speak("हाँ");
    await call.waitFor(/बुक हो गया है/);
    call.speak("नहीं बस धन्यवाद");
    await call.waitFor(/अपना ध्यान रखिए/);
    expect(await call.closed).toBe(1000);

    // The call is saved just after the hang-up; wait for it rather than for a fixed time.
    await expect.poll(async () => (await record(callId)).status, { timeout: 5000 }).toBe("ended");
    const row = await record(callId);
    expect(row).toMatchObject({ outcome: "booked", status: "ended" });
    expect(row.usage.stt_ms).toBeGreaterThan(0);
    expect(row.usage.tts_chars).toBeGreaterThan(0);
    expect(row.latency.turns).toBeGreaterThanOrEqual(4);
    expect(row.latency.p95).toBeLessThan(1500);
    expect(jobs.jobs.some((j) => j.task === "plan_messages")).toBe(true);
    const turns = (
      await db.pool.query("select speaker, text from call_turns where call_id = $1 order by seq", [callId])
    ).rows;
    expect(turns.filter((t) => t.speaker === "caller").map((t) => t.text)).toEqual([
      "मुझे कल शाम को चेकअप के लिए आना है",
      "हाँ जी",
      "पहला वाला",
      "हाँ",
      "नहीं बस धन्यवाद",
    ]);
  });

  it("barge-in: talking over an interruptible reply stops it at once", async () => {
    const { call } = await dial(undefined, { autoAck: false });
    // The greeting (a notice) finishes playing; the question after it stays "playing" (never acknowledged).
    await call.waitFor(/रिकॉर्ड/);
    call.ack(call.marks[0]!);
    await call.waitFor(/मदद कर सकती हूँ/);
    call.speak("clinic ka address kya hai");
    await call.waitFor(/Lalpur/);
    expect(call.cleared()).toBeGreaterThanOrEqual(1);
    call.ws.close();
  });

  it("talk during the recording notice is not taken as an answer", async () => {
    const { call, callId } = await dial(undefined, { autoAck: false });
    // Speak while the greeting (not interruptible) is still playing.
    await new Promise((r) => setTimeout(r, 100));
    call.speak("hello hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(call.cleared()).toBe(0);
    const callerTurns = (
      await db.pool.query(
        "select count(*)::int as n from call_turns where call_id = $1 and speaker = 'caller'",
        [callId],
      )
    ).rows[0].n;
    expect(callerTurns).toBe(0);
    call.ws.close();
  });

  it("silence: checks the caller is there, then ends the call", async () => {
    const { call, callId } = await dial();
    await call.waitFor(/क्या आप लाइन पर हैं/, 3000);
    expect(await call.closed).toBe(1000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await record(callId)).outcome).toBe("no_input");
  });

  it("emergency: plays the script, hands the call over, and sends the doctor alerts now", async () => {
    const { call, callId } = await dial();
    await call.waitFor(/मदद कर सकती हूँ/);
    call.speak("मेरे गाल में बहुत सूजन है और साँस लेने में दिक्कत है");
    await call.waitFor(/112/);
    expect(await call.closed).toBe(1000);
    const row = await record(callId);
    expect(row).toMatchObject({ outcome: "emergency", transfer_kind: "emergency", status: "transferring" });
    expect(jobs.jobs.some((j) => j.task === "outbox_sweep")).toBe(true);
  });

  it("says 'one moment' when understanding is slow", async () => {
    const { call } = await dial();
    await call.waitFor(/मदद कर सकती हूँ/);
    speech.delayMs = 300;
    try {
      call.speak("clinic kab khulta hai");
      await call.waitFor(/एक सेकंड.*खुला रहता है/s);
    } finally {
      speech.delayMs = 0;
    }
    call.ws.close();
  });

  it("speech-to-text failure: asks again instead of guessing", async () => {
    const { call } = await dial();
    await call.waitFor(/मदद कर सकती हूँ/);
    speech.support.failNext("timeout");
    call.speak("kuch bhi");
    await call.waitFor(/फिर बोलिए/);
    call.ws.close();
  });

  it("keypad 0 hands the call to staff", async () => {
    const { call, callId } = await dial();
    await call.waitFor(/मदद कर सकती हूँ/);
    call.ws.send(JSON.stringify({ event: "dtmf", stream_sid: "st1", dtmf: { digit: "0" } }));
    expect(await call.closed).toBe(1000);
    expect((await record(callId)).transfer_kind).toBe("staff");
  });

  it("refuses a media stream without the secret key", async () => {
    const bad = new WebSocket(url.replace(/key=[^&]+/, "key=wrong"));
    const status = await new Promise<number>((resolve) =>
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(401);
  });

  it("handles 10 calls at once within the latency budget", async () => {
    const calls = await Promise.all(Array.from({ length: 10 }, () => dial()));
    await Promise.all(calls.map(({ call }) => call.waitFor(/मदद कर सकती हूँ/)));
    for (const { call } of calls) call.speak("clinic ka address kya hai");
    await Promise.all(calls.map(({ call }) => call.waitFor(/Lalpur/, 10_000)));
    for (const { call } of calls) call.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await db.pool.query(
      "select latency_ms from call_turns where call_id = any($1) and latency_ms is not null",
      [calls.map((c) => c.callId)],
    );
    expect(rows).toHaveLength(10);
    const sorted = rows.map((r) => r.latency_ms as number).sort((a, b) => a - b);
    expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThan(1500);
  });
});

import { bytesOf, concatBytes, fakeSpeechAudio, silence } from "@dentalos/adapters";
import { describe, expect, it } from "vitest";
import { Endpointer } from "./endpointer";

const noise = (ms: number, level: number) => {
  const n = (8000 * ms) / 1000;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round((Math.random() * 2 - 1) * level);
  return bytesOf(s);
};

describe("Endpointer", () => {
  it("finds an utterance between silences, with pre-roll, and reports speech start", () => {
    const ep = new Endpointer({ sampleRate: 8000, silenceMs: 600 });
    const speech = fakeSpeechAudio("kal shaam 5 baje");
    const events = [...ep.push(silence(1000)), ...ep.push(speech), ...ep.push(silence(700))];
    expect(events.map((e) => e.type)).toEqual(["speech_start", "utterance"]);
    const u = events[1] as { pcm: Uint8Array; durationMs: number };
    // The whole utterance is kept, including the first frames that were only recognised afterwards.
    expect(Buffer.from(u.pcm).includes(Buffer.from(speech.subarray(0, 64)))).toBe(true);
    expect(u.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it("ignores background noise and short clicks", () => {
    const ep = new Endpointer({ sampleRate: 8000 });
    const events = [
      ...ep.push(noise(3000, 300)),
      ...ep.push(noise(40, 9000)), // a click
      ...ep.push(noise(2000, 300)),
    ];
    expect(events).toEqual([]);
  });

  it("adapts to a noisy line: steady noise above the fixed minimum is not speech", () => {
    const ep = new Endpointer({ sampleRate: 8000 });
    // Rising noise the floor can follow, then steady.
    for (let level = 100; level <= 900; level += 100) ep.push(noise(500, level));
    expect(ep.push(noise(3000, 900))).toEqual([]);
    expect(ep.push(concatBytes([fakeSpeechAudio("haan"), silence(1000)])).map((e) => e.type)).toEqual([
      "speech_start",
      "utterance",
    ]);
  });

  it("cuts very long speech at the maximum length", () => {
    const ep = new Endpointer({ sampleRate: 8000, maxUtteranceMs: 2000 });
    const long = concatBytes(Array.from({ length: 10 }, () => fakeSpeechAudio("bahut lamba vakya")));
    expect(ep.push(long).filter((e) => e.type === "utterance").length).toBeGreaterThanOrEqual(1);
  });

  it("accepts audio in odd chunk sizes", () => {
    const ep = new Endpointer({ sampleRate: 8000, silenceMs: 400 });
    const all = concatBytes([silence(500), fakeSpeechAudio("namaste"), silence(600)]);
    const events = [];
    for (let i = 0; i < all.byteLength; i += 333) events.push(...ep.push(all.subarray(i, i + 333)));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "utterance"]);
  });
});

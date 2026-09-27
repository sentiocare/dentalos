import type { RawWebhook } from "../common.js";
import { FakeSupport, fakeId } from "../fake-support.js";
import type { VoiceCapabilities, VoiceEvent, VoiceProvider } from "./types.js";

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = "fake-voice";
  readonly support: FakeSupport;
  readonly capabilities: VoiceCapabilities = {
    toolWebhooks: true,
    transcriptStream: true,
    responseInterception: true,
    languages: ["hi-IN", "en-IN", "bn-IN"],
  };
  readonly sessions = new Map<string, { providerCallId: string; language: string; ended: boolean }>();
  readonly spoken: { sessionId: string; text: string }[] = [];
  /** Transcripts returned for voice notes, keyed by mime type; default echoes a fixed Hinglish line. */
  transcriptFor: (audio: Uint8Array) => { text: string; language: string } = () => ({
    text: "mujhe kal appointment chahiye",
    language: "hi-IN",
  });

  constructor(webhookSecret = "fake-voice-secret") {
    this.support = new FakeSupport(this.name, webhookSecret);
  }

  async startSession(input: { providerCallId: string; language: string }) {
    this.support.throwIfScripted();
    const sessionId = fakeId("vs");
    this.sessions.set(sessionId, {
      providerCallId: input.providerCallId,
      language: input.language,
      ended: false,
    });
    return { sessionId, sipUri: `sip:${sessionId}@fake-voice.local` };
  }

  async say(sessionId: string, text: string) {
    this.support.throwIfScripted();
    this.spoken.push({ sessionId, text });
  }

  async endSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.ended = true;
  }

  async transcribe(input: { audio: Uint8Array }) {
    this.support.throwIfScripted();
    return this.transcriptFor(input.audio);
  }

  healthCheck() {
    return this.support.healthCheck();
  }

  verifyWebhook(webhook: RawWebhook) {
    return this.support.verifyWebhook(webhook);
  }

  parseWebhook(webhook: RawWebhook) {
    return this.support.parseWebhook<VoiceEvent>(webhook);
  }

  eventWebhook(events: VoiceEvent[]): RawWebhook {
    return this.support.signWebhook(events);
  }
}

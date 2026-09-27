import { safeEqualHex } from "../common";
import { FakeSupport, fakeId } from "../fake-support";
import { ExotelProvider, exotelStreamCodec } from "./exotel";
import type { CallStatusEvent, FlowDecision, FlowHttpRequest, TelephonyProvider } from "./types";

/**
 * Fake telephony for development and tests. It speaks the same media-stream and call-flow formats as
 * Exotel, so the voice service is exercised exactly as in production; nothing is dialled.
 */
export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name = "fake-telephony";
  readonly support = new FakeSupport(this.name, "fake-telephony-secret");
  readonly stream = exotelStreamCodec;
  readonly placedCalls: { providerCallId: string; to: string; callerId: string; flowId: string }[] = [];
  readonly recordings = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private readonly exotel: ExotelProvider;

  constructor(readonly callbackToken = "fake-telephony-token-0123456789") {
    this.exotel = new ExotelProvider({ accountSid: "fake", apiKey: "fake", apiToken: "fake", callbackToken });
  }

  verifyFlowRequest(request: FlowHttpRequest) {
    const key = request.params.key ?? "";
    return !!key && safeEqualHex(key, this.callbackToken);
  }

  parseFlowRequest(request: FlowHttpRequest) {
    return this.exotel.parseFlowRequest(request);
  }

  flowResponse(decision: FlowDecision) {
    return this.exotel.flowResponse(decision);
  }

  parseStatusCallback(request: FlowHttpRequest): CallStatusEvent | null {
    return this.exotel.parseStatusCallback(request);
  }

  async placeCall(input: { to: string; callerId: string; flowId: string }) {
    this.support.throwIfScripted();
    const providerCallId = fakeId("call");
    this.placedCalls.push({ providerCallId, ...input });
    return { providerCallId };
  }

  async fetchRecording(url: string) {
    this.support.throwIfScripted();
    return this.recordings.get(url) ?? null;
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

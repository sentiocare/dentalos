import { FakeSupport, fakeId } from "../fake-support.js";
import type { SmsProvider } from "./types.js";

export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake-sms";
  readonly support = new FakeSupport(this.name, "unused");
  readonly sent: { providerMessageId: string; to: string; text: string; dltTemplateId: string }[] = [];

  async send(input: { to: string; text: string; dltTemplateId: string; senderId: string }) {
    this.support.throwIfScripted();
    if (!input.dltTemplateId) {
      throw new Error("SMS without a DLT template id is not allowed (TRAI)");
    }
    const providerMessageId = fakeId("sms");
    this.sent.push({ providerMessageId, to: input.to, text: input.text, dltTemplateId: input.dltTemplateId });
    return { providerMessageId };
  }

  healthCheck() {
    return this.support.healthCheck();
  }
}

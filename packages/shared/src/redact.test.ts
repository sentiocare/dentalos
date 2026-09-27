import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { scrubText, scrubValue } from "./redact.js";

describe("scrubText", () => {
  it.each([
    "call 9876543210 now",
    "call +91 98765 43210 now",
    "call 098765-43210 now",
    "landline 0651-2345678 ok",
  ])("masks phone numbers in %j", (input) => {
    expect(scrubText(input)).not.toMatch(/\d{5}/);
    expect(scrubText(input)).toContain("[phone]");
  });

  it("masks emails", () => {
    expect(scrubText("mail dr.sharma@example.com")).toBe("mail [email]");
  });

  it("leaves ordinary numbers alone", () => {
    expect(scrubText("slot 45 min, amount 1500, tooth 46")).toBe("slot 45 min, amount 1500, tooth 46");
  });
});

describe("scrubValue", () => {
  it("removes PII keys at any depth and scrubs strings", () => {
    const out = scrubValue({
      clinicId: "c1",
      patient: { name: "Ramesh Kumar", phone: "+919876543210", tooth: 46 },
      note: "caller 9876543210 asked",
    });
    expect(out).toEqual({
      clinicId: "c1",
      patient: { name: "[redacted]", phone: "[redacted]", tooth: 46 },
      note: "caller [phone] asked",
    });
  });

  it("keeps dates readable", () => {
    expect(scrubValue({ at: new Date("2026-10-01T04:30:00Z") })).toEqual({ at: "2026-10-01T04:30:00.000Z" });
  });
});

describe("createLogger", () => {
  it("never writes patient names or numbers", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ service: "test" }, sink);
    log.info({ patient: { name: "Sunita Devi", phone: "+919812345678" } }, "booked for 9812345678");
    log.error({ err: new Error("failed for sunita@example.com") }, "oops");
    const output = lines.join("");
    expect(output).not.toContain("Sunita");
    expect(output).not.toContain("9812345678");
    expect(output).not.toContain("sunita@example.com");
    expect(output).toContain("[phone]");
  });

  it("logs request method and path but drops query strings", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ service: "test" }, sink);
    log.info({ req: { id: "r1", method: "GET", url: "/patients/search?q=9876543210" } }, "incoming");
    const entry = JSON.parse(lines[0]!);
    expect(entry.req).toEqual({ id: "r1", method: "GET", url: "/patients/search" });
    expect(lines[0]).not.toContain("9876543210");
  });
});

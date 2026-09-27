import { describe, expect, it } from "vitest";
import { checkOutput } from "../safety/output-filter";
import { allCopy, say } from "./copy";

describe("assistant copy", () => {
  const entries = Object.entries(allCopy());

  it("every message exists in all three languages", () => {
    for (const [, value] of entries)
      for (const lang of ["en", "hi", "hinglish"] as const) expect(value[lang].trim()).not.toBe("");
  });

  it("button titles fit WhatsApp's 20-character limit", () => {
    for (const [key, value] of entries.filter(([k]) => k.startsWith("btn_"))) {
      for (const text of Object.values(value)) expect(text.length, `${key}: ${text}`).toBeLessThanOrEqual(20);
    }
  });

  it("no message trips the safety filter (after filling placeholders)", () => {
    for (const [key] of entries) {
      for (const lang of ["en", "hi", "hinglish"] as const) {
        const text = say(lang, key as never, {
          clinic: "Sharma Dental",
          procedure: "RCT",
          min: "₹3,500",
          max: "₹7,000",
          when: "Tuesday",
          doctor: "Dr. Sharma",
          patient: "Ramesh",
        });
        expect(checkOutput(text), `${key}/${lang}`).toEqual({ ok: true });
      }
    }
  });

  it("uses respectful Hinglish (aap, never tum)", () => {
    for (const [, value] of entries) expect(value.hinglish).not.toMatch(/\btum\b/i);
  });
});

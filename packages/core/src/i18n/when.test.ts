import { describe, expect, it } from "vitest";
import { buttonLabel, whenInWords } from "./when";

const TZ = "Asia/Kolkata";
const at = (s: string) => new Date(`${s}+05:30`);

describe("whenInWords", () => {
  it("reads back like the spec example", () => {
    expect(whenInWords(at("2026-10-13T17:00:00"), TZ, "hinglish")).toBe(
      "Mangalvaar, 13 October, shaam 5 baje",
    );
    expect(whenInWords(at("2026-10-13T17:00:00"), TZ, "hi")).toBe("मंगलवार, 13 अक्टूबर, शाम 5 बजे");
    expect(whenInWords(at("2026-10-13T17:00:00"), TZ, "en")).toBe("Tuesday, 13 October, 5:00 pm");
  });

  it.each([
    ["2026-10-13T10:15:00", "subah sawa 10 baje"],
    ["2026-10-13T10:30:00", "subah saadhe 10 baje"],
    ["2026-10-13T10:45:00", "subah paune 11 baje"],
    ["2026-10-13T13:30:00", "dopahar dedh baje"],
    ["2026-10-13T14:30:00", "dopahar dhaai baje"],
    ["2026-10-13T11:45:00", "subah paune 12 baje"],
    ["2026-10-13T12:45:00", "dopahar paune 1 baje"],
    ["2026-10-13T19:45:00", "raat paune 8 baje"],
    ["2026-10-13T17:10:00", "shaam 5:10 baje"],
  ])("%s → %s", (time, words) => {
    expect(whenInWords(at(time), TZ, "hinglish").endsWith(words)).toBe(true);
  });

  it("button labels fit WhatsApp's 20-character limit", () => {
    for (const lang of ["en", "hi", "hinglish"] as const) {
      expect(buttonLabel(at("2026-12-30T19:45:00"), TZ, lang).length).toBeLessThanOrEqual(20);
    }
    expect(buttonLabel(at("2026-10-13T17:30:00"), TZ, "en")).toBe("Tue 13 Oct 5:30pm");
  });
});

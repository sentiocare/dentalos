import { describe, expect, it } from "vitest";
import { parseClockPreference } from "./clock";

describe("parseClockPreference", () => {
  it.each([
    ["shaam 5 baje", 17 * 60],
    ["5 baje", 17 * 60],
    ["subah 11 baje", 11 * 60],
    ["10:30", 10 * 60 + 30],
    ["saadhe 5 baje", 17 * 60 + 30],
    ["sawa 6", 18 * 60 + 15],
    ["paune 7 baje", 18 * 60 + 45],
    ["dedh baje", 13 * 60 + 30],
    ["at 5 pm tomorrow", 17 * 60],
    ["कल शाम पाँच बजे", 17 * 60],
    ["सुबह साढ़े दस बजे", 10 * 60 + 30],
    ["12 baje", 12 * 60],
  ])("%s", (text, minutes) => {
    expect(parseClockPreference(text)).toBe(minutes);
  });

  it("no time mentioned", () => {
    expect(parseClockPreference("kal shaam ko")).toBeNull();
    expect(parseClockPreference("2 din baad")).toBeNull();
  });
});

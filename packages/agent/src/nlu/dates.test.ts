import { describe, expect, it } from "vitest";
import { parseDatePreference, parsePartsOfDay } from "./dates";

// 2026-10-30 is a Friday, near a month end.
const TODAY = "2026-10-30";

describe("parseDatePreference", () => {
  it.each([
    ["kal aana hai", "2026-10-31"],
    ["tomorrow evening", "2026-10-31"],
    ["कल शाम", "2026-10-31"],
    ["parso", "2026-11-01"],
    ["aaj ho sakta hai?", "2026-10-30"],
    ["monday ko", "2026-11-02"],
    ["mangalvaar", "2026-11-03"],
    ["next Tuesday", "2026-11-03"],
    ["agle shukravaar", "2026-11-06"],
    ["Friday", "2026-10-30"],
    ["14 Nov", "2026-11-14"],
    ["Nov 14", "2026-11-14"],
    ["3rd december", "2026-12-03"],
    ["5/1", "2027-01-05"],
    ["20 oct", "2027-10-20"],
  ])("%j → %s", (text, date) => {
    expect(parseDatePreference(text, TODAY)?.fromDate).toBe(date);
  });

  it("understands ranges", () => {
    expect(parseDatePreference("agle hafte kabhi bhi", TODAY)).toMatchObject({
      fromDate: "2026-11-02",
      toDate: "2026-11-07",
    });
    expect(parseDatePreference("this week", TODAY)).toMatchObject({
      fromDate: "2026-10-30",
      toDate: "2026-10-31",
    });
  });

  it("across the year end", () => {
    expect(parseDatePreference("kal", "2026-12-31")?.fromDate).toBe("2027-01-01");
    expect(parseDatePreference("next monday", "2026-12-28")?.fromDate).toBe("2027-01-04");
  });

  it("returns null when there is no date", () => {
    expect(parseDatePreference("RCT kitna ka hai", TODAY)).toBeNull();
  });
});

describe("parsePartsOfDay", () => {
  it.each([
    ["shaam ko", ["evening"]],
    ["subah 10 baje", ["morning"]],
    ["after lunch, afternoon", ["afternoon"]],
    ["सुबह", ["morning"]],
  ])("%j", (text, parts) => expect(parsePartsOfDay(text)).toEqual(parts));
});

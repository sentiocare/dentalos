import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  localDateOf,
  localMinutesOf,
  parseTime,
  weekdayOf,
  zonedInstant,
} from "./time";

const IST = "Asia/Kolkata";

describe("clinic-local time", () => {
  it("converts IST wall-clock time to the right instant", () => {
    expect(zonedInstant("2026-10-06", 17 * 60, IST).toISOString()).toBe("2026-10-06T11:30:00.000Z");
    expect(zonedInstant("2026-10-06", 0, IST).toISOString()).toBe("2026-10-05T18:30:00.000Z");
  });

  it("round-trips across midnight", () => {
    const late = new Date("2026-10-06T19:00:00Z"); // 00:30 IST on the 7th
    expect(localDateOf(late, IST)).toBe("2026-10-07");
    expect(localMinutesOf(late, IST)).toBe(30);
  });

  it("works in a zone with daylight saving too", () => {
    expect(zonedInstant("2026-07-01", 9 * 60, "Europe/London").toISOString()).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(zonedInstant("2026-12-01", 9 * 60, "Europe/London").toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
  });

  it("date arithmetic across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
  });

  it("weekday 0 = Sunday", () => {
    expect(weekdayOf("2026-10-04")).toBe(0);
    expect(weekdayOf("2026-10-06")).toBe(2);
  });

  it("parses Postgres times", () => {
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("17:00:00")).toBe(1020);
    expect(() => parseTime("25:00")).toThrow();
  });
});

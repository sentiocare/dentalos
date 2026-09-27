import { describe, expect, it } from "vitest";
import { applyBasisPoints, divRound, formatINR, rupeesToPaise } from "./money";

describe("rupeesToPaise", () => {
  it.each([
    ["1500", 150000],
    ["1,500.50", 150050],
    ["₹ 1,23,456.5", 12345650],
    ["Rs. 99", 9900],
    ["0.07", 7],
    [250, 25000],
    ["-40", -4000],
  ])("parses %j", (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "1..2", "12a"])("rejects %j", (input) => {
    expect(() => rupeesToPaise(input)).toThrow(RangeError);
  });

  it("does not suffer float rounding", () => {
    expect(rupeesToPaise("0.29")).toBe(29);
    expect(rupeesToPaise("1.15")).toBe(115);
  });
});

describe("formatINR", () => {
  it("uses Indian digit grouping", () => {
    expect(formatINR(12345650)).toBe("₹1,23,456.5");
    expect(formatINR(200000)).toBe("₹2,000");
  });
});

describe("divRound / applyBasisPoints", () => {
  it("rounds half up", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(-5, 2)).toBe(-3);
  });

  it("applies 18% GST in basis points", () => {
    expect(applyBasisPoints(100000, 1800)).toBe(18000);
    expect(applyBasisPoints(333, 1800)).toBe(60);
  });
});

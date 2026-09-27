import { describe, expect, it } from "vitest";
import { formatPhoneForDisplay, isIndianMobile, normalizePhone, type E164 } from "./phone";

describe("normalizePhone", () => {
  it.each(["9876543210", "98765 43210", "098765-43210", "+91 98765 43210", "+919876543210", "91 9876543210"])(
    "normalises mobile %j",
    (input) => {
      expect(normalizePhone(input)).toBe("+919876543210");
    },
  );

  it("normalises a Ranchi landline", () => {
    expect(normalizePhone("0651 2345678")).toBe("+916512345678");
  });

  it.each(["", "12345", "not a phone", "0123456789"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe("isIndianMobile / formatPhoneForDisplay", () => {
  it("distinguishes mobiles from landlines", () => {
    expect(isIndianMobile("+919876543210" as E164)).toBe(true);
    expect(isIndianMobile("+916512345678" as E164)).toBe(false);
  });

  it("formats for display", () => {
    expect(formatPhoneForDisplay("+919876543210" as E164)).toBe("98765 43210");
  });
});

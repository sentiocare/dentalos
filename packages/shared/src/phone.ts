import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** A phone number in E.164 form, e.g. "+919876543210". */
export type E164 = string & { readonly __brand: "E164" };

/**
 * Normalises how Indian clinics and patients write numbers ("98765 43210", "098765-43210",
 * "+91 98765 43210", "0651 2345678") into E.164. Returns null when the input is not a valid number.
 */
export function normalizePhone(input: string, defaultCountry: "IN" = "IN"): E164 | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number as E164;
}

/** True for Indian mobile numbers (the only ones that can receive WhatsApp and SMS reliably). */
export function isIndianMobile(phone: E164): boolean {
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed || parsed.country !== "IN") return false;
  const type = parsed.getType();
  return type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";
}

/** "+919876543210" → "98765 43210" for display to Indian staff. */
export function formatPhoneForDisplay(phone: E164): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone);
  return m ? `${m[1]} ${m[2]}` : phone;
}

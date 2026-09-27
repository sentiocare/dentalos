import { formatPhoneForDisplay, type E164 } from "@dentalos/shared/phone";

/** "+919876543210" → "98765 43210"; other numbers are shown as stored. */
export function displayPhone(phone: string | null | undefined): string {
  return phone ? formatPhoneForDisplay(phone as E164) : "";
}

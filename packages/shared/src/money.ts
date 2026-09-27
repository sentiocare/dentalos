/**
 * Money is always an integer number of paise (1 rupee = 100 paise). Never use floats for money.
 * Postgres stores it as bigint; `number` is safe up to ~9 × 10^13 rupees, far beyond any clinic.
 */
export type Paise = number;

export function assertPaise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Invalid paise amount: ${value}`);
  }
  return value;
}

/** Parses "1500", "1,500.50", "₹ 1,500.5" or a number of rupees into exact paise, without float rounding. */
export function rupeesToPaise(input: string | number): Paise {
  const text = typeof input === "number" ? input.toString() : input;
  const cleaned = text.replace(/[₹,\s]/g, "").replace(/^Rs\.?/i, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new RangeError(`Invalid rupee amount: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, fraction = ""] = match;
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return assertPaise(sign ? -paise : paise);
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Formats paise in Indian grouping, e.g. 12345650 → "₹1,23,456.5". */
export function formatINR(paise: Paise): string {
  return inrFormatter.format(assertPaise(paise) / 100);
}

/** Integer division with round-half-up (away from zero for positives), used for margins and tax. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("denominator must be positive");
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) * 2 + denominator) / (2 * denominator));
}

/** Applies a percentage expressed in basis points (1% = 100 bps), rounding half-up to whole paise. */
export function applyBasisPoints(amount: Paise, bps: number): Paise {
  if (!Number.isInteger(bps)) throw new RangeError("bps must be an integer");
  return divRound(assertPaise(amount) * bps, 10_000);
}

import Decimal from 'decimal.js';

/**
 * Money helper (project rule 3 and the money rule): amounts and prices are decimal STRINGS
 * ("0.00000123"), never JavaScript floats. decimal.js does the arithmetic and comparisons.
 *
 * Accepted input is deliberately strict: plain unsigned decimal text only.
 * Rejected: "", " 1", "-1", "1e5", "NaN", "Infinity", "1,5", ".5", "5.".
 * Limits: up to 30 digits before the point and 18 after it.
 */

// Own copy of Decimal so global settings elsewhere can never change our results.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });

const DECIMAL_PATTERN = /^\d{1,30}(\.\d{1,18})?$/;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

/** True when the text is a valid decimal string (unsigned, plain notation, within limits). */
export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

/** Parses a decimal string. Throws DecimalError with a clear message when invalid. */
export function parseDecimal(value: string): Decimal {
  if (!isDecimalString(value)) {
    throw new DecimalError(
      `"${String(value)}" is not a valid amount. Use plain digits like 100 or 0.00012 ` +
        '(no minus sign, no exponent, at most 30 digits before and 18 after the point).',
    );
  }
  return new D(value);
}

/** Canonical text form: no leading or trailing zeros, never exponent notation ("0.10" -> "0.1"). */
export function normalizeDecimal(value: string): string {
  return parseDecimal(value).toFixed();
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  return parseDecimal(a).comparedTo(parseDecimal(b)) as -1 | 0 | 1;
}

export function isPositive(value: string): boolean {
  return parseDecimal(value).greaterThan(0);
}

export function isZero(value: string): boolean {
  return parseDecimal(value).isZero();
}

export function addDecimal(a: string, b: string): string {
  return parseDecimal(a).plus(parseDecimal(b)).toFixed();
}

/**
 * Display text. Without `decimals` it is the exact canonical value; with `decimals` it is rounded
 * half-even to that many places and padded with zeros ("1.5" with 2 -> "1.50").
 */
export function formatDecimal(value: string, decimals?: number): string {
  const parsed = parseDecimal(value);
  return decimals === undefined ? parsed.toFixed() : parsed.toFixed(decimals);
}

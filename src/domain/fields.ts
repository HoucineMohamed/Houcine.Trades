import { z } from 'zod';
import { isDecimalString, isPositive, normalizeDecimal } from './money/decimal';

/**
 * Reusable zod field builders. They normalise input (trim, upper-case, canonical decimals)
 * and give clear messages. Optional/nullable handling is left to the caller.
 */

const required = (label: string) => ({ error: `${label} is required` });

export function text(label: string, max: number) {
  return z.string(required(label)).trim().max(max, `${label} must be at most ${max} characters`);
}

export function nonEmptyText(label: string, max: number) {
  return text(label, max).min(1, `${label} is required`);
}

type DecimalKind = 'positive' | 'nonNegative';

export function decimalField(label: string, kind: DecimalKind) {
  return z
    .string(required(label))
    .trim()
    .refine(
      isDecimalString,
      `${label} must be a plain number like 100 or 0.00012 (no minus sign, no exponent, max 30 digits before and 18 after the point)`,
    )
    .refine(
      (v) => kind === 'nonNegative' || !isDecimalString(v) || isPositive(v),
      `${label} must be greater than 0`,
    )
    .transform((v) => normalizeDecimal(v));
}

/** Currency or asset code such as USD, EUR, BTC, USDT. Upper-cased. */
export function currencyCode(label: string) {
  return z
    .string(required(label))
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, `${label} must be 2-10 letters or digits, like USD or BTC`);
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Parses an ISO-8601 UTC timestamp ("2026-10-03T18:21:00Z"). Returns null when invalid. */
export function parseIsoUtc(value: string): Date | null {
  if (!ISO_UTC.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates such as 2026-02-31 that some parsers roll over.
  if (date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return date;
}

/** UTC timestamp field. Output is the canonical form ("2026-10-03T18:21:00.000Z"). */
export function timestampField(label: string) {
  return z
    .string(required(label))
    .trim()
    .refine(
      (v) => parseIsoUtc(v) !== null,
      `${label} must be a valid UTC time like 2026-10-03T18:21:00Z`,
    )
    .transform((v) => (parseIsoUtc(v) as Date).toISOString());
}

/**
 * A screenshot reference is a file path or an http(s) link. Any other scheme (javascript:, data:,
 * file:, ...) is refused so it can never become a dangerous link.
 */
export function isSafeScreenshotRef(value: string): boolean {
  if (/^https?:\/\/\S+$/i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true; // Windows path such as C:\shots\a.png
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value); // no other "scheme:"
}

export function screenshotField() {
  return text('Screenshot', 500).refine(
    (v) => v === '' || isSafeScreenshotRef(v),
    'Screenshot must be a file path or an http(s) link',
  );
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

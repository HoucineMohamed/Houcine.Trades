import { Dec } from '../money/decimal';
import type { Metric } from './types';

/** Fixed output precision (see types.ts and docs/stats-glossary.md). */
export const PRECISION = { ratio: 4, percent: 2, money: 8 } as const;

/** Trades needed before statistics are considered reliable. */
export const MIN_RELIABLE_TRADES = 30;

/** Rounds half-even to `places` and pads with zeros. Never returns "-0.00". */
export function fixed(value: Dec, places: number): string {
  const rounded = value.toDecimalPlaces(places, Dec.ROUND_HALF_EVEN);
  return (rounded.isZero() ? rounded.abs() : rounded).toFixed(places);
}

/** Exact canonical text, no rounding, never "-0". */
export function exact(value: Dec): string {
  return value.isZero() ? '0' : value.toFixed();
}

export const some = (value: string): Metric => ({ value, reason: null });
export const none = (reason: string): Metric => ({ value: null, reason });

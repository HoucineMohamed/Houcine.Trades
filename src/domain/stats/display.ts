import { Dec } from '../money/decimal';

/**
 * Display text for a money value: at most `places` decimals (half-even), trailing zeros trimmed,
 * never "-0". This is presentation only; the engine's own values are untouched.
 */
export function displayMoney(value: string, places = 8): string {
  const rounded = new Dec(value).toDecimalPlaces(places, Dec.ROUND_HALF_EVEN);
  return (rounded.isZero() ? rounded.abs() : rounded).toFixed();
}

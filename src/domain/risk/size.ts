import { Dec, isDecimalString, isPositive } from '../money/decimal';
import { HARD_CEILINGS } from './settings';
import type { Problem } from './types';

/**
 * Position-size calculator (pure, exact).
 *
 *   risk budget      = equity x risk % / 100
 *   risk per unit    = |entry - stop| + entry x round-trip fee % / 100
 *   size             = budget / risk per unit, ROUNDED DOWN to the size step
 *
 * Rounding is always DOWN so the money at risk can never exceed the budget. Division inside this
 * file also truncates (never rounds up), and a final exact check refuses to answer if the size
 * somehow exceeded the budget.
 */

// Same precision as Dec, but every operation rounds toward zero.
const Down = Dec.clone({ rounding: Dec.ROUND_DOWN });

export interface SizeInput {
  equity: string | null;
  riskPercent: string | null;
  direction: string;
  entry: string | null;
  stop: string | null;
  /** Optional: size must be a multiple of this (exchange lot / tick step). */
  sizeStep?: string | null;
  /** Optional: refuse if the rounded-down size is smaller than this. */
  minSize?: string | null;
  /** Optional estimate of ALL fees for the round trip, as a percent of the trade value. */
  feeRoundTripPercent?: string | null;
  /** Optional take-profit, to report reward-to-risk. */
  target?: string | null;
}

export interface SizeSuccess {
  ok: true;
  size: string;
  /** size x |entry - stop|: the loss if the stop is hit (before fees). */
  riskAmount: string;
  /** Estimated round-trip fees at this size (0 when no estimate was given). */
  estimatedFees: string;
  /** riskAmount + estimatedFees as a percent of equity, rounded UP to 4 decimals. */
  riskPercentUsed: string;
  riskBudget: string;
  /** size x entry. */
  notional: string;
  /** reward distance / risk distance rounded DOWN to 4 decimals; null without a target. */
  rewardToRisk: string | null;
}

export type SizeResult = SizeSuccess | { ok: false; problems: Problem[] };

const MAX_SIZE_DECIMALS = 18; // the journal stores sizes with at most 18 decimals

export function calculatePositionSize(input: SizeInput): SizeResult {
  const problems: Problem[] = [];
  const bad = (code: string, message: string) => problems.push({ code, message });
  const positive = (v: string | null | undefined): v is string =>
    typeof v === 'string' && isDecimalString(v) && isPositive(v);

  if (!positive(input.equity))
    bad(
      'EQUITY_UNAVAILABLE',
      'Equity is missing or not above zero, so the size cannot be calculated.',
    );
  if (!positive(input.riskPercent)) {
    bad('INVALID_RISK_PERCENT', 'Risk percent is missing or not above zero.');
  } else if (new Dec(input.riskPercent).gt(HARD_CEILINGS.maxRiskPerTradePercent)) {
    bad(
      'RISK_ABOVE_CEILING',
      `Risk percent ${input.riskPercent} is above the hard ceiling of ${HARD_CEILINGS.maxRiskPerTradePercent}%.`,
    );
  }
  if (input.direction !== 'long' && input.direction !== 'short')
    bad('INVALID_PLAN', 'Direction must be long or short.');
  if (!positive(input.entry)) bad('INVALID_PLAN', 'Entry price is missing or not above zero.');
  if (input.stop === null || input.stop === '' || input.stop === undefined) {
    bad('NO_STOP_LOSS', 'A stop-loss is required.');
  } else if (!positive(input.stop)) {
    bad('NO_STOP_LOSS', 'The stop-loss is not a valid price above zero.');
  }
  const optional = (v: string | null | undefined) => v !== null && v !== undefined && v !== '';
  if (optional(input.sizeStep) && !positive(input.sizeStep))
    bad('INVALID_STEP', 'Size step must be a number above zero.');
  if (optional(input.minSize) && !positive(input.minSize))
    bad('INVALID_MIN_SIZE', 'Minimum size must be a number above zero.');
  if (optional(input.feeRoundTripPercent)) {
    const fee = input.feeRoundTripPercent as string;
    if (!isDecimalString(fee) || new Dec(fee).gte(100)) {
      bad('INVALID_FEE', 'Estimated fees must be a percent from 0 up to (not including) 100.');
    }
  }
  if (optional(input.target) && !positive(input.target))
    bad('TARGET_WRONG_SIDE', 'The target is not a valid price above zero.');
  if (problems.length > 0) return { ok: false, problems };

  const equity = new Down(input.equity as string);
  const entry = new Down(input.entry as string);
  const stop = new Down(input.stop as string);
  const long = input.direction === 'long';

  if (long ? stop.gte(entry) : stop.lte(entry)) {
    bad(
      stop.eq(entry) ? 'ZERO_STOP_DISTANCE' : 'STOP_WRONG_SIDE',
      stop.eq(entry)
        ? 'The stop-loss equals the entry price (zero distance), so the risk per unit is zero.'
        : `For a ${input.direction} trade the stop-loss must be ${long ? 'below' : 'above'} the entry price.`,
    );
    return { ok: false, problems };
  }

  let rewardDistance: InstanceType<typeof Down> | null = null;
  if (optional(input.target)) {
    const target = new Down(input.target as string);
    if (long ? target.lte(entry) : target.gte(entry)) {
      bad(
        'TARGET_WRONG_SIDE',
        `For a ${input.direction} trade the target must be ${long ? 'above' : 'below'} the entry price.`,
      );
      return { ok: false, problems };
    }
    rewardDistance = target.minus(entry).abs();
  }

  const distance = entry.minus(stop).abs();
  const feePercent = new Down(
    optional(input.feeRoundTripPercent) ? (input.feeRoundTripPercent as string) : '0',
  );
  const feePerUnit = entry.times(feePercent).div(100);
  const riskPerUnit = distance.plus(feePerUnit);
  const budget = equity.times(input.riskPercent as string).div(100);

  let size: InstanceType<typeof Down>;
  if (optional(input.sizeStep)) {
    const step = new Down(input.sizeStep as string);
    size = budget.div(riskPerUnit).div(step).floor().times(step);
  } else {
    size = budget.div(riskPerUnit).toDecimalPlaces(MAX_SIZE_DECIMALS, Dec.ROUND_DOWN);
  }

  // Last line of defence: the exact money at risk must not exceed the budget.
  if (size.times(riskPerUnit).gt(budget)) {
    return {
      ok: false,
      problems: [
        {
          code: 'INTERNAL_CHECK_FAILED',
          message: 'The calculated size would exceed the risk budget, so it was refused.',
        },
      ],
    };
  }

  const minSize = optional(input.minSize) ? new Down(input.minSize as string) : null;
  if (size.lte(0)) {
    return {
      ok: false,
      problems: [
        {
          code: 'SIZE_BELOW_MINIMUM',
          message:
            'The risk budget is too small to buy even the smallest size at this stop distance.',
        },
      ],
    };
  }
  if (minSize !== null && size.lt(minSize)) {
    return {
      ok: false,
      problems: [
        {
          code: 'SIZE_BELOW_MINIMUM',
          message: `The largest allowed size (${size.toFixed()}) is below the minimum size (${minSize.toFixed()}).`,
        },
      ],
    };
  }

  const riskAmount = size.times(distance);
  const estimatedFees = size.times(feePerUnit);
  const used = riskAmount.plus(estimatedFees).times(100).div(equity);
  return {
    ok: true,
    size: size.toFixed(),
    riskAmount: riskAmount.toFixed(),
    estimatedFees: estimatedFees.toFixed(),
    riskPercentUsed: used.toDecimalPlaces(4, Dec.ROUND_UP).toFixed(4),
    riskBudget: budget.toFixed(),
    notional: size.times(entry).toFixed(),
    rewardToRisk:
      rewardDistance === null
        ? null
        : rewardDistance.div(distance).toDecimalPlaces(4, Dec.ROUND_DOWN).toFixed(4),
  };
}

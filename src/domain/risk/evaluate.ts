import { Dec, isDecimalString, isPositive } from '../money/decimal';
import type { RiskContext } from './context';
import type {
  OpenTradeRisk,
  TradePlan,
  Verdict,
  VerdictNumbers,
  Violation,
  Warning,
} from './types';

/**
 * Plan evaluation: may this plan be taken? Pure and deterministic.
 *
 * - FAIL CLOSED: missing, invalid or ambiguous data is a violation. Nothing is approved by default.
 * - ALL violations are listed, not only the first.
 * - Limits are compared with EXACT decimals by cross-multiplication (never with rounded
 *   percentages). A limit reached exactly is allowed; the smallest unit over is refused.
 * - The AI only proposes plans. This function has the final say, and a refused plan can never
 *   become an order (see guard.ts: requireApprovedForExecution has no override).
 */

const positive = (v: string | null | undefined): v is string =>
  typeof v === 'string' && isDecimalString(v) && isPositive(v);

/** Initial risk of an open trade in the account currency, or a reason it cannot be verified. */
export function openTradeRisk(
  trade: OpenTradeRisk,
  baseCurrency: string,
): { ok: true; risk: Dec } | { ok: false; reason: string } {
  if (trade.quoteCurrency !== baseCurrency) {
    return {
      ok: false,
      reason: `open trade #${trade.tradeId} is quoted in ${trade.quoteCurrency}, not ${baseCurrency}`,
    };
  }
  if (!positive(trade.entryPrice) || !positive(trade.initialStopLoss) || !positive(trade.size)) {
    return {
      ok: false,
      reason: `open trade #${trade.tradeId} has no valid entry, initial stop-loss or size`,
    };
  }
  const risk = new Dec(trade.entryPrice).minus(trade.initialStopLoss).abs().times(trade.size);
  return { ok: true, risk };
}

export function evaluatePlan(plan: TradePlan, ctx: RiskContext): Verdict {
  const violations: Violation[] = [];
  const warnings: Warning[] = [];
  const violate = (code: Violation['code'], message: string) => violations.push({ code, message });
  const warn = (code: Warning['code'], message: string) => warnings.push({ code, message });

  const numbers: VerdictNumbers = {
    equity: ctx.equity,
    riskAmount: null,
    riskPercent: null,
    riskLimitAmount: null,
    openRiskBefore: null,
    openRiskAfter: null,
    openRiskAfterPercent: null,
    openRiskLimitAmount: null,
    openTradesBefore: ctx.openTrades.length,
    openTradesAfter: ctx.openTrades.length + 1,
    maxOpenTrades: ctx.settings?.maxOpenTrades ?? null,
    rewardToRisk: null,
  };

  // 1. account and settings --------------------------------------------------------------------
  if (!ctx.accountKnown)
    violate('ACCOUNT_UNKNOWN', 'The account does not exist, so the risk cannot be verified.');
  if (ctx.settings === null) {
    violate(
      'SETTINGS_INVALID',
      `The risk settings are missing or invalid, so the plan is refused: ${ctx.settingsProblem ?? 'unknown problem'}.`,
    );
  }

  // 2. halts -----------------------------------------------------------------------------------
  for (const halt of ctx.halts) {
    const code =
      halt.kind === 'daily_loss'
        ? 'HALTED_DAILY_LOSS'
        : halt.kind === 'drawdown'
          ? 'HALTED_DRAWDOWN'
          : 'HALTED_MANUAL';
    violate(code, halt.message);
  }

  // 3. the plan itself -------------------------------------------------------------------------
  const long = plan.direction === 'long';
  const directionOk = plan.direction === 'long' || plan.direction === 'short';
  if (!directionOk) violate('INVALID_PLAN', 'Direction must be long or short.');
  const entryOk = positive(plan.entry);
  if (!entryOk) violate('INVALID_PLAN', 'The entry price is missing or not a number above zero.');
  const sizeOk = positive(plan.size);
  if (!sizeOk) violate('INVALID_PLAN', 'The size is missing or not a number above zero.');

  const stopMissing =
    plan.stop === null || plan.stop === undefined || String(plan.stop).trim() === '';
  const stopOk = positive(plan.stop);
  if (stopMissing) violate('NO_STOP_LOSS', 'A stop-loss is required on every plan.');
  else if (!stopOk) violate('NO_STOP_LOSS', 'The stop-loss is not a valid price above zero.');

  let sidesOk = directionOk && entryOk && stopOk;
  if (directionOk && entryOk && stopOk) {
    const entry = new Dec(plan.entry as string);
    const stop = new Dec(plan.stop as string);
    if (long ? stop.gte(entry) : stop.lte(entry)) {
      sidesOk = false;
      violate(
        'STOP_WRONG_SIDE',
        `For a ${plan.direction} trade the stop-loss (${plan.stop}) must be ${long ? 'below' : 'above'} the entry price (${plan.entry}).`,
      );
    }
  }
  const hasTarget =
    plan.target !== null && plan.target !== undefined && String(plan.target).trim() !== '';
  let targetOk = false;
  if (hasTarget) {
    if (!positive(plan.target)) {
      violate('TARGET_WRONG_SIDE', 'The target is not a valid price above zero.');
    } else if (directionOk && entryOk) {
      const target = new Dec(plan.target);
      const entry = new Dec(plan.entry as string);
      if (long ? target.lte(entry) : target.gte(entry)) {
        violate(
          'TARGET_WRONG_SIDE',
          `For a ${plan.direction} trade the target (${plan.target}) must be ${long ? 'above' : 'below'} the entry price (${plan.entry}).`,
        );
      } else {
        targetOk = true;
      }
    }
  }

  // 4. money limits (only when the numbers can be trusted) -------------------------------------
  const currencyOk = ctx.baseCurrency !== null && plan.quoteCurrency === ctx.baseCurrency;
  if (ctx.baseCurrency !== null && !currencyOk) {
    violate(
      'CURRENCY_MISMATCH',
      `The plan is quoted in ${plan.quoteCurrency} but the account currency is ${ctx.baseCurrency}: risk cannot be verified without currency conversion.`,
    );
  }
  if (ctx.accountKnown && ctx.equity === null) {
    violate(
      'EQUITY_UNAVAILABLE',
      ctx.equityProblem ?? 'Equity is unavailable, so the risk cannot be verified.',
    );
  }

  const priceOk = sidesOk && sizeOk;
  const dist = priceOk ? new Dec(plan.entry as string).minus(plan.stop as string).abs() : null;
  const risk = dist && sizeOk ? dist.times(plan.size as string) : null;
  if (risk) numbers.riskAmount = risk.toFixed();

  if (hasTarget && targetOk && dist) {
    const reward = new Dec(plan.target as string).minus(plan.entry as string).abs();
    numbers.rewardToRisk = reward.div(dist).toDecimalPlaces(4, Dec.ROUND_DOWN).toFixed(4);
  }

  const equity = ctx.equity !== null ? new Dec(ctx.equity) : null;
  if (risk && equity && currencyOk && ctx.settings) {
    const s = ctx.settings;
    // per-trade risk: risk <= equity x pct / 100  <=>  risk x 100 <= equity x pct
    numbers.riskPercent = risk.times(100).div(equity).toDecimalPlaces(4, Dec.ROUND_UP).toFixed(4);
    numbers.riskLimitAmount = equity.times(s.maxRiskPerTradePercent).div(100).toFixed();
    if (risk.times(100).gt(equity.times(s.maxRiskPerTradePercent))) {
      violate(
        'MAX_RISK_PER_TRADE',
        `This trade risks ${risk.toFixed()} (${numbers.riskPercent}% of equity), above the limit of ${s.maxRiskPerTradePercent}% (${numbers.riskLimitAmount}).`,
      );
    }

    // total open risk
    let openBefore = new Dec(0);
    const unverifiable: string[] = [];
    for (const t of ctx.openTrades) {
      const r = openTradeRisk(t, ctx.baseCurrency as string);
      if (r.ok) openBefore = openBefore.plus(r.risk);
      else unverifiable.push(r.reason);
    }
    if (unverifiable.length > 0) {
      violate(
        'OPEN_RISK_UNVERIFIABLE',
        `The total open risk cannot be verified: ${unverifiable.join('; ')}.`,
      );
    } else {
      const after = openBefore.plus(risk);
      numbers.openRiskBefore = openBefore.toFixed();
      numbers.openRiskAfter = after.toFixed();
      numbers.openRiskAfterPercent = after
        .times(100)
        .div(equity)
        .toDecimalPlaces(4, Dec.ROUND_UP)
        .toFixed(4);
      numbers.openRiskLimitAmount = equity.times(s.maxOpenRiskPercent).div(100).toFixed();
      if (after.times(100).gt(equity.times(s.maxOpenRiskPercent))) {
        violate(
          'MAX_OPEN_RISK',
          `Total open risk would be ${after.toFixed()} (${numbers.openRiskAfterPercent}% of equity), above the limit of ${s.maxOpenRiskPercent}% (${numbers.openRiskLimitAmount}).`,
        );
      }
    }
  }

  // number of open trades (does not need money, only settings)
  if (ctx.settings && ctx.openTrades.length + 1 > ctx.settings.maxOpenTrades) {
    violate(
      'MAX_OPEN_TRADES',
      `${ctx.openTrades.length} trade(s) are already open; one more would exceed the limit of ${ctx.settings.maxOpenTrades}.`,
    );
  }

  // 5. warnings (never a refusal) -------------------------------------------------------------
  if (!hasTarget) {
    warn('NO_TARGET', 'No take-profit was given, so the reward-to-risk could not be checked.');
  } else if (targetOk && dist && ctx.settings) {
    const reward = new Dec(plan.target as string).minus(plan.entry as string).abs();
    if (reward.lt(dist.times(ctx.settings.minRewardToRisk))) {
      warn(
        'LOW_REWARD_TO_RISK',
        `Reward-to-risk is ${numbers.rewardToRisk}, below your minimum of ${ctx.settings.minRewardToRisk}. This is a warning, not a refusal.`,
      );
    }
  }
  if (ctx.tradesWithExcludedFees > 0) {
    warn(
      'EQUITY_MAY_BE_OVERSTATED',
      `${ctx.tradesWithExcludedFees} closed trade(s) had fees in another currency that were not deducted, so equity may be slightly too high.`,
    );
  }

  return { approved: violations.length === 0, violations, warnings, numbers, evaluatedAt: ctx.now };
}

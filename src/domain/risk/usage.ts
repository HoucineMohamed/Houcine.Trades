import { Dec } from '../money/decimal';
import type { RiskContext } from './context';
import { openTradeRisk } from './evaluate';

/**
 * How much of each limit is in use right now. PURE and read-only: it explains the state the risk
 * engine already derived; it never approves or refuses anything and changes no rule. The page
 * only displays these numbers.
 *
 * Reuses the engine's own definitions: today's loss and the day-start equity from the context,
 * open risk from `openTradeRisk` (initial stop, account currency only), drawdown from the peak
 * since the last baseline. A figure that cannot be verified is `null` with a reason (fail closed:
 * never shown as zero).
 *
 * Rounding: shares are rounded UP so usage is never understated (like the verdict's risk percent).
 */

export interface UsageLine {
  /** Amount used, in the account currency (exact text), or null when it cannot be verified. */
  used: string | null;
  /** The limit as an amount, or null when it cannot be worked out. */
  limitAmount: string | null;
  /** The configured limit, in percent. */
  limitPercent: string | null;
  /** used as a percent of what the limit is measured against (2 decimals, rounded up). */
  usedPercent: string | null;
  /** used as a percent of the limit amount (2 decimals, rounded up). Above 100 means over. */
  shareOfLimit: string | null;
  /** True when used has reached the limit (exact comparison). Null when unknown. */
  reached: boolean | null;
  /** Why the figures are missing (plain words), or null. */
  problem: string | null;
}

export interface CountUsage {
  used: number;
  limit: number | null;
  reached: boolean | null;
}

export interface RiskUsage {
  baseCurrency: string | null;
  dailyLoss: UsageLine;
  openRisk: UsageLine;
  openTrades: CountUsage;
  drawdown: UsageLine;
}

const unknown = (problem: string, limitPercent: string | null = null): UsageLine => ({
  used: null,
  limitAmount: null,
  limitPercent,
  usedPercent: null,
  shareOfLimit: null,
  reached: null,
  problem,
});

const up2 = (v: Dec) => v.toDecimalPlaces(2, Dec.ROUND_UP).toFixed(2);

/** used / base as a percent, and used / limit as a percent, both rounded up. */
function line(used: Dec, base: Dec, limitPercent: string): UsageLine {
  const limitAmount = base.times(limitPercent).div(100);
  return {
    used: used.isZero() ? '0' : used.toFixed(),
    limitAmount: limitAmount.toFixed(),
    limitPercent,
    usedPercent: up2(used.times(100).div(base)),
    shareOfLimit: limitAmount.gt(0) ? up2(used.times(100).div(limitAmount)) : null,
    reached: used.gte(limitAmount),
    problem: null,
  };
}

export function computeRiskUsage(ctx: RiskContext): RiskUsage {
  const settings = ctx.settings;
  const settingsProblem = `The risk settings are missing or invalid (${ctx.settingsProblem ?? 'unknown problem'}).`;
  const equityProblem = ctx.equityProblem ?? 'Equity cannot be verified.';

  // ---- daily loss: today's realised loss against the equity at the start of the UTC day ----
  let dailyLoss: UsageLine;
  if (settings === null) dailyLoss = unknown(settingsProblem);
  else if (ctx.dayStartEquity === null)
    dailyLoss = unknown(ctx.dayStartProblem ?? equityProblem, settings.maxDailyLossPercent);
  else {
    const net = new Dec(ctx.todayNetPnl);
    const loss = net.isNegative() ? net.abs() : new Dec(0);
    dailyLoss = line(loss, new Dec(ctx.dayStartEquity), settings.maxDailyLossPercent);
  }

  // ---- open risk: the initial risk of every open trade, against current equity ----------------
  let openRisk: UsageLine;
  if (settings === null) openRisk = unknown(settingsProblem);
  else if (ctx.equity === null || ctx.baseCurrency === null)
    openRisk = unknown(equityProblem, settings.maxOpenRiskPercent);
  else {
    let total = new Dec(0);
    let problem: string | null = null;
    for (const trade of ctx.openTrades) {
      const risk = openTradeRisk(trade, ctx.baseCurrency);
      if (!risk.ok) {
        problem = `The open risk cannot be verified: ${risk.reason}.`;
        break;
      }
      total = total.plus(risk.risk);
    }
    openRisk = problem
      ? unknown(problem, settings.maxOpenRiskPercent)
      : line(total, new Dec(ctx.equity), settings.maxOpenRiskPercent);
  }

  // ---- open trades: a plain count ---------------------------------------------------------------
  const limit = settings?.maxOpenTrades ?? null;
  const openTrades: CountUsage = {
    used: ctx.openTrades.length,
    limit,
    reached: limit === null ? null : ctx.openTrades.length >= limit,
  };

  // ---- drawdown: the fall from the peak since the last baseline ----------------------------------
  let drawdown: UsageLine;
  if (settings === null) drawdown = unknown(settingsProblem);
  else if (ctx.peakEquity === null || ctx.fallFromPeak === null)
    drawdown = unknown(equityProblem, settings.maxDrawdownPercent);
  else if (!new Dec(ctx.peakEquity).gt(0))
    drawdown = unknown(
      'The peak equity is zero, so the drawdown cannot be measured.',
      settings.maxDrawdownPercent,
    );
  else
    drawdown = line(
      new Dec(ctx.fallFromPeak),
      new Dec(ctx.peakEquity),
      settings.maxDrawdownPercent,
    );

  return { baseCurrency: ctx.baseCurrency, dailyLoss, openRisk, openTrades, drawdown };
}

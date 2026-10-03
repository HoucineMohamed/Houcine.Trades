import { Dec } from '../money/decimal';
import { exact, fixed, MIN_RELIABLE_TRADES, none, PRECISION, some } from './format';
import type { TradeCalc } from './trade';
import type { EquityCurve, GroupStats, MaxDrawdown, SampleSize } from './types';

/** Chronological order: closed time, then trade id (so equal times are still deterministic). */
export function sortChronologically(calcs: TradeCalc[]): TradeCalc[] {
  return [...calcs].sort((a, b) => a.closedMs - b.closedMs || a.id - b.id);
}

const sum = (values: Dec[]) => values.reduce((acc, v) => acc.plus(v), new Dec(0));

/**
 * Equity curve and maximum drawdown.
 *
 * `start` is the starting balance (base currency only) or null when this group has none; then the
 * curve starts at 0 (cumulative net P&L), the drawdown AMOUNT is still computed, and the percent
 * is null with `noStartReason`.
 *
 * Max drawdown = the deepest fall from a peak. With a starting balance it is the fall with the
 * largest PERCENT (its amount is the amount of that same fall; earliest wins a tie). The curve
 * begins at the starting balance, so a loss on the very first trade counts as a drawdown.
 */
export function analyzeEquity(
  calcs: TradeCalc[],
  start: Dec | null,
  noStartReason: string,
): { curve: EquityCurve; maxDrawdown: MaxDrawdown } {
  const ordered = sortChronologically(calcs);
  let equity = start ?? new Dec(0);
  let peak = equity;
  let maxAmount = new Dec(0);
  let bestPercent: Dec | null = null;
  let bestPercentAmount = new Dec(0);
  const points = ordered.map((c) => {
    equity = equity.plus(c.net);
    if (equity.gt(peak)) peak = equity;
    const fall = peak.minus(equity);
    if (fall.gt(maxAmount)) maxAmount = fall;
    if (start !== null && peak.gt(0)) {
      const percent = fall.div(peak).times(100);
      if (bestPercent === null || percent.gt(bestPercent)) {
        bestPercent = percent;
        bestPercentAmount = fall;
      }
    }
    return {
      tradeId: c.id,
      closedAt: c.result.closedAt,
      netPnl: c.result.netPnl,
      equity: exact(equity),
    };
  });

  const curve: EquityCurve = {
    startsFromAccountBalance: start !== null,
    startingEquity: exact(start ?? new Dec(0)),
    points,
  };

  let maxDrawdown: MaxDrawdown;
  if (start === null) {
    maxDrawdown = { amount: exact(maxAmount), percent: none(noStartReason) };
  } else if (bestPercent !== null) {
    maxDrawdown = {
      amount: exact(bestPercentAmount),
      percent: some(fixed(bestPercent, PRECISION.percent)),
    };
  } else {
    maxDrawdown = {
      amount: exact(maxAmount),
      percent: none(
        ordered.length === 0
          ? 'no closed trades'
          : 'the equity never rose above zero, so a percentage cannot be defined',
      ),
    };
  }
  return { curve, maxDrawdown };
}

function sampleSize(tradeCount: number): SampleSize {
  const reliable = tradeCount >= MIN_RELIABLE_TRADES;
  return {
    tradeCount,
    minimumReliable: MIN_RELIABLE_TRADES,
    reliable,
    warning: reliable
      ? null
      : `Only ${tradeCount} closed trade${tradeCount === 1 ? '' : 's'}. Fewer than ${MIN_RELIABLE_TRADES} ` +
        'trades is too few for these statistics to be reliable: a lucky or unlucky streak can ' +
        'look like skill or failure.',
  };
}

/** Metrics for one group of trades (all in the same currency). */
export function computeGroupStats(
  calcs: TradeCalc[],
  start: Dec | null,
  noStartReason: string,
): GroupStats {
  const ordered = sortChronologically(calcs);
  const count = ordered.length;

  const winners = ordered.filter((c) => c.result.outcome === 'win');
  const losers = ordered.filter((c) => c.result.outcome === 'loss');
  const breakevens = ordered.filter((c) => c.result.outcome === 'breakeven');

  const grossPnl = sum(ordered.map((c) => c.gross));
  const netPnl = sum(ordered.map((c) => c.net));
  const totalFees = sum(ordered.map((c) => new Dec(c.result.feesApplied)));
  const totalWinners = sum(winners.map((c) => c.net));
  const totalLosers = sum(losers.map((c) => c.net)); // negative or zero

  const averageWin = winners.length > 0 ? totalWinners.div(winners.length) : null;
  const averageLoss = losers.length > 0 ? totalLosers.div(losers.length) : null;

  const grossRs = ordered.flatMap((c) => (c.grossR === null ? [] : [c.grossR]));
  const netRs = ordered.flatMap((c) => (c.netR === null ? [] : [c.netR]));

  // Streaks: a breakeven trade ends both a winning and a losing streak.
  let winRun = 0;
  let lossRun = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const c of ordered) {
    winRun = c.result.outcome === 'win' ? winRun + 1 : 0;
    lossRun = c.result.outcome === 'loss' ? lossRun + 1 : 0;
    longestWinStreak = Math.max(longestWinStreak, winRun);
    longestLossStreak = Math.max(longestLossStreak, lossRun);
  }

  const noTrades = 'no closed trades';
  const largestWin = winners.length
    ? winners.reduce((m, c) => (c.net.gt(m) ? c.net : m), winners[0]!.net)
    : null;
  const largestLoss = losers.length
    ? losers.reduce((m, c) => (c.net.lt(m) ? c.net : m), losers[0]!.net)
    : null;

  let profitFactor = none(noTrades);
  if (count > 0) {
    profitFactor = totalLosers.isZero()
      ? none('no losing trades, so dividing by total losers is not possible')
      : some(fixed(totalWinners.div(totalLosers.abs()), PRECISION.ratio));
  }

  let payoffRatio = none(noTrades);
  if (count > 0) {
    payoffRatio =
      averageWin === null
        ? none('no winning trades')
        : averageLoss === null
          ? none('no losing trades')
          : some(fixed(averageWin.div(averageLoss.abs()), PRECISION.ratio));
  }

  const { maxDrawdown } = analyzeEquity(ordered, start, noStartReason);

  return {
    tradeCount: count,
    wins: winners.length,
    losses: losers.length,
    breakevens: breakevens.length,
    winRatePercent:
      count > 0
        ? some(fixed(new Dec(winners.length).div(count).times(100), PRECISION.percent))
        : none(noTrades),
    grossPnl: exact(grossPnl),
    totalFees: exact(totalFees),
    netPnl: exact(netPnl),
    totalWinners: exact(totalWinners),
    totalLosers: exact(totalLosers),
    averageWin: averageWin ? some(fixed(averageWin, PRECISION.money)) : none('no winning trades'),
    averageLoss: averageLoss ? some(fixed(averageLoss, PRECISION.money)) : none('no losing trades'),
    largestWin: largestWin ? some(exact(largestWin)) : none('no winning trades'),
    largestLoss: largestLoss ? some(exact(largestLoss)) : none('no losing trades'),
    averageR: grossRs.length
      ? some(fixed(sum(grossRs).div(grossRs.length), PRECISION.ratio))
      : none(count === 0 ? noTrades : 'no trade has an initial stop-loss to measure R against'),
    expectancyR: netRs.length
      ? some(fixed(sum(netRs).div(netRs.length), PRECISION.ratio))
      : none(
          count === 0
            ? noTrades
            : 'net R is not available for any trade (missing initial stop or fees in another currency)',
        ),
    expectancyMoney: count > 0 ? some(fixed(netPnl.div(count), PRECISION.money)) : none(noTrades),
    profitFactor,
    payoffRatio,
    longestWinStreak,
    longestLossStreak,
    maxDrawdown,
    sampleSize: sampleSize(count),
    flags: {
      tradesWithExcludedFees: ordered.filter((c) => c.result.feesExcluded).length,
      rTradeCount: grossRs.length,
      netRTradeCount: netRs.length,
    },
  };
}

import type { VerdictNumbers, RiskSettings } from '../risk';
import type { GroupStats, Metric, TradeResult } from '../stats';
import type { Fact } from './prompt';

/**
 * Turns engine results into the plain facts the prompt shows. This only COPIES values and
 * labels them (project rule 3): nothing is calculated here, and a missing figure stays "n/a"
 * with its reason, never a zero.
 */

const metric = (key: string, m: Metric): Fact[] => [
  { key, value: m.value, figure: true },
  ...(m.value === null && m.reason ? [{ key: `${key} (why n/a)`, value: m.reason }] : []),
];

/** The headline statistics of one currency (the stats engine's own numbers and wording). */
export function factsFromGroupStats(g: GroupStats): Fact[] {
  return [
    { key: 'closed trades', value: g.tradeCount, figure: true },
    { key: 'wins', value: g.wins, figure: true },
    { key: 'losses', value: g.losses, figure: true },
    { key: 'breakevens', value: g.breakevens, figure: true },
    ...metric('win rate percent', g.winRatePercent),
    { key: 'gross P&L (before fees)', value: g.grossPnl, figure: true },
    { key: 'total fees', value: g.totalFees, figure: true },
    { key: 'net P&L (after fees)', value: g.netPnl, figure: true },
    { key: 'total winners (net)', value: g.totalWinners, figure: true },
    { key: 'total losers (net)', value: g.totalLosers, figure: true },
    ...metric('average win', g.averageWin),
    ...metric('average loss', g.averageLoss),
    ...metric('largest win', g.largestWin),
    ...metric('largest loss', g.largestLoss),
    ...metric('expectancy (R)', g.expectancyR),
    ...metric('expectancy (money)', g.expectancyMoney),
    ...metric('profit factor', g.profitFactor),
    ...metric('payoff ratio', g.payoffRatio),
    { key: 'longest win streak', value: g.longestWinStreak, figure: true },
    { key: 'longest loss streak', value: g.longestLossStreak, figure: true },
    { key: 'max drawdown amount', value: g.maxDrawdown.amount, figure: true },
    ...metric('max drawdown percent', g.maxDrawdown.percent),
    {
      key: 'trades whose fees were left out (other currency)',
      value: g.flags.tradesWithExcludedFees,
      figure: true,
    },
  ];
}

/** Net result of one closed trade, from the stats engine. */
export function factsFromTradeResult(r: TradeResult): Fact[] {
  return [{ key: 'net P&L', value: r.netPnl, figure: true }, ...metric('net R', r.netR)];
}

const v = (key: string, value: string | number | null): Fact => ({ key, value, figure: true });

/** The risk engine's numbers for a plan (account currency, percent of equity, counts). */
export function factsFromVerdictNumbers(n: VerdictNumbers): Fact[] {
  return [
    v('equity (account currency)', n.equity),
    v('risk amount at the stop (account currency)', n.riskAmount),
    v('risk percent of equity', n.riskPercent),
    v('risk limit amount (account currency)', n.riskLimitAmount),
    v('open risk before (account currency)', n.openRiskBefore),
    v('open risk after (account currency)', n.openRiskAfter),
    v('open risk after percent', n.openRiskAfterPercent),
    v('open risk limit amount (account currency)', n.openRiskLimitAmount),
    v('open trades before', n.openTradesBefore),
    v('open trades after', n.openTradesAfter),
    v('max open trades', n.maxOpenTrades),
    v('reward-to-risk', n.rewardToRisk),
  ];
}

/** The user's saved (effective) risk rules. */
export function factsFromRiskSettings(s: RiskSettings): Fact[] {
  return [
    v('max risk per trade percent', s.maxRiskPerTradePercent),
    v('max daily loss percent', s.maxDailyLossPercent),
    v('max total open risk percent', s.maxOpenRiskPercent),
    v('max open trades', s.maxOpenTrades),
    v('max drawdown percent', s.maxDrawdownPercent),
    v('minimum reward-to-risk', s.minRewardToRisk),
  ];
}

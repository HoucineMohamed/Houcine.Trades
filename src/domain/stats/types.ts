import type { Direction } from '../trades/types';

/**
 * Stats engine types. Everything here is plain data: the engine is pure and imports nothing from
 * the data layer, the UI or integrations. Money values are decimal STRINGS.
 *
 * Output precision (documented in docs/stats-glossary.md):
 *  - sums and products of money ("exact"): canonical decimal text, never rounded
 *  - money averages and expectancy: 8 decimals, half-even, always padded
 *  - R values, profit factor, payoff ratio: 4 decimals
 *  - percentages (win rate, drawdown): in percent, 2 decimals
 */

/** A closed trade as the stats engine needs it. The data layer builds these. */
export interface StatsTrade {
  id: number;
  symbol: string;
  assetClass: string;
  direction: Direction | string;
  quoteCurrency: string;
  entryPrice: string | null;
  exitPrice: string | null;
  size: string | null;
  /** The stop the trade started with (frozen when it opened). Null makes R unavailable. */
  initialStopLoss: string | null;
  fees: string;
  feesCurrency: string;
  closedAt: string | null;
  setupId: number | null;
  setupName: string | null;
}

export interface StatsInput {
  account: { id: number; name: string; baseCurrency: string; startingBalance: string };
  trades: StatsTrade[];
}

/** A number that may be unavailable. When `value` is null, `reason` says why in plain words. */
export interface Metric {
  value: string | null;
  reason: string | null;
}

export type Outcome = 'win' | 'loss' | 'breakeven';

export interface TradeResult {
  tradeId: number;
  closedAt: string;
  /** (exit - entry) x size for a long, (entry - exit) x size for a short. Before fees. */
  grossPnl: string;
  /** Fees actually deducted: 0 when the fees are in another currency (see feesExcluded). */
  feesApplied: string;
  /** True when the trade has non-zero fees in a currency different from its quote currency. */
  feesExcluded: boolean;
  /** grossPnl - feesApplied. */
  netPnl: string;
  outcome: Outcome;
  /** |entry - initial stop| x size, in the quote currency. */
  initialRisk: Metric;
  grossR: Metric;
  netR: Metric;
}

export interface SkippedTrade {
  tradeId: number;
  reason: string;
}

export interface SampleSize {
  tradeCount: number;
  minimumReliable: number;
  reliable: boolean;
  warning: string | null;
}

export interface MaxDrawdown {
  /** Largest peak-to-trough fall of the equity curve, in money (0 when it never fell). */
  amount: string;
  /** The same fall as a percent of its peak. Null when it cannot be defined (see reason). */
  percent: Metric;
}

export interface GroupStats {
  tradeCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePercent: Metric;
  /** Total before fees (fees in another currency were never deducted anyway). */
  grossPnl: string;
  /** Fees actually deducted. */
  totalFees: string;
  netPnl: string;
  /** Sum of the net P&L of all winning trades (>= 0). */
  totalWinners: string;
  /** Sum of the net P&L of all losing trades (<= 0, shown negative). */
  totalLosers: string;
  averageWin: Metric;
  /** Negative number. */
  averageLoss: Metric;
  largestWin: Metric;
  /** Negative number. */
  largestLoss: Metric;
  /** Average gross R over trades whose R is available. */
  averageR: Metric;
  /** Average NET R over trades whose net R is available (see netRTradeCount). */
  expectancyR: Metric;
  /** Average net P&L per trade. */
  expectancyMoney: Metric;
  profitFactor: Metric;
  payoffRatio: Metric;
  longestWinStreak: number;
  longestLossStreak: number;
  maxDrawdown: MaxDrawdown;
  sampleSize: SampleSize;
  flags: {
    /** Trades whose fees were left out of net P&L because of a different currency. */
    tradesWithExcludedFees: number;
    /** Trades that have a gross R. */
    rTradeCount: number;
    /** Trades that have a net R (the basis of expectancyR). */
    netRTradeCount: number;
  };
}

export interface EquityPoint {
  tradeId: number;
  closedAt: string;
  netPnl: string;
  equity: string;
}

export interface EquityCurve {
  /** True when the curve starts at the account's starting balance (base currency only). */
  startsFromAccountBalance: boolean;
  /** The starting balance, or "0" when there is none in this currency. */
  startingEquity: string;
  /** One point after each closed trade, ordered by closed time (then trade id). */
  points: EquityPoint[];
}

export interface Breakdown {
  key: string;
  label: string;
  stats: GroupStats;
}

export interface CurrencyStats {
  quoteCurrency: string;
  isBaseCurrency: boolean;
  overall: GroupStats;
  equityCurve: EquityCurve;
  tradeResults: TradeResult[];
  bySetup: Breakdown[];
  bySymbol: Breakdown[];
  byDirection: Breakdown[];
  byAssetClass: Breakdown[];
  skipped: SkippedTrade[];
  notes: string[];
}

export interface AccountStats {
  accountId: number;
  accountName: string;
  baseCurrency: string;
  startingBalance: string;
  /** One entry per quote currency, base currency first, then alphabetical. Never mixed. */
  currencies: CurrencyStats[];
}

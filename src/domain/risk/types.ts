/**
 * Risk engine types. Pure data: the engine imports nothing from the data layer, the UI or
 * integrations. Money and percentages are decimal STRINGS (see docs/risk-rules.md).
 */

export interface Problem {
  code: string;
  message: string;
}

export const VIOLATION_CODES = [
  'ACCOUNT_UNKNOWN',
  'SETTINGS_INVALID',
  'INVALID_PLAN',
  'NO_STOP_LOSS',
  'STOP_WRONG_SIDE',
  'TARGET_WRONG_SIDE',
  'CURRENCY_MISMATCH',
  'EQUITY_UNAVAILABLE',
  'HALTED_DAILY_LOSS',
  'HALTED_DRAWDOWN',
  'HALTED_MANUAL',
  'MAX_RISK_PER_TRADE',
  'MAX_OPEN_RISK',
  'OPEN_RISK_UNVERIFIABLE',
  'MAX_OPEN_TRADES',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export const WARNING_CODES = [
  'LOW_REWARD_TO_RISK',
  'NO_TARGET',
  'EQUITY_MAY_BE_OVERSTATED',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface Violation {
  code: ViolationCode;
  message: string;
}
export interface Warning {
  code: WarningCode;
  message: string;
}

/** A trade plan as the risk engine sees it. Everything is text and may be missing: fail closed. */
export interface TradePlan {
  symbol: string;
  direction: string;
  entry: string | null;
  stop: string | null;
  target: string | null;
  size: string | null;
  quoteCurrency: string;
}

/** An open trade, with what is needed to compute its initial risk. */
export interface OpenTradeRisk {
  tradeId: number;
  quoteCurrency: string;
  entryPrice: string | null;
  initialStopLoss: string | null;
  size: string | null;
}

export interface VerdictNumbers {
  equity: string | null;
  /** |entry - stop| x size, in the account currency. */
  riskAmount: string | null;
  /** Percent of current equity, rounded UP to 4 decimals (never understates). */
  riskPercent: string | null;
  riskLimitAmount: string | null;
  openRiskBefore: string | null;
  openRiskAfter: string | null;
  openRiskAfterPercent: string | null;
  openRiskLimitAmount: string | null;
  openTradesBefore: number;
  openTradesAfter: number;
  maxOpenTrades: number | null;
  /** Reward / risk distance, rounded DOWN to 4 decimals (never overstates). */
  rewardToRisk: string | null;
}

export interface Verdict {
  approved: boolean;
  violations: Violation[];
  warnings: Warning[];
  numbers: VerdictNumbers;
  evaluatedAt: string;
}

import { parseIsoUtc } from '../fields';
import { Dec, isDecimalString, isPositive } from '../money/decimal';
import { exact, fixed, none, PRECISION, some } from './format';
import type { Outcome, SkippedTrade, StatsTrade, TradeResult } from './types';

/**
 * Per-trade calculations. Assumption (documented in the glossary): spot-style P&L. No leverage,
 * no contract multipliers, no funding. P&L = price difference x size, in the quote currency.
 */

export interface TradeCalc {
  id: number;
  closedMs: number;
  trade: StatsTrade;
  /** Exact values used for all aggregation (results below are the printable versions). */
  gross: Dec;
  net: Dec;
  grossR: Dec | null;
  netR: Dec | null;
  result: TradeResult;
}

export type TradeCalcOutcome = { ok: true; calc: TradeCalc } | { ok: false; skipped: SkippedTrade };

const positive = (v: string | null): v is string =>
  v !== null && isDecimalString(v) && isPositive(v);

export function calculateTrade(t: StatsTrade): TradeCalcOutcome {
  const skip = (reason: string): TradeCalcOutcome => ({
    ok: false,
    skipped: { tradeId: t.id, reason },
  });

  // A trade that cannot be calculated is reported, never guessed and never allowed to crash us.
  if (t.direction !== 'long' && t.direction !== 'short')
    return skip('direction is not long or short');
  if (!positive(t.entryPrice)) return skip('entry price is missing or invalid');
  if (!positive(t.exitPrice)) return skip('exit price is missing or invalid');
  if (!positive(t.size)) return skip('size is missing or invalid');
  if (!isDecimalString(t.fees)) return skip('fees are invalid');
  const closed = t.closedAt === null ? null : parseIsoUtc(t.closedAt);
  if (t.closedAt === null || closed === null) return skip('closed time is missing or invalid');

  const entry = new Dec(t.entryPrice);
  const exit = new Dec(t.exitPrice);
  const size = new Dec(t.size);
  const fees = new Dec(t.fees);

  // Gross P&L: long = (exit - entry) x size, short = (entry - exit) x size.
  const gross = (t.direction === 'long' ? exit.minus(entry) : entry.minus(exit)).times(size);

  // Fees in a different currency are NOT converted (no guessing): left out and flagged.
  // Zero fees are harmless in any currency, so they are never flagged.
  const feesExcluded = !fees.isZero() && t.feesCurrency !== t.quoteCurrency;
  const feesApplied = feesExcluded ? new Dec(0) : fees;
  const net = gross.minus(feesApplied);

  // R uses the stop the trade STARTED with, never the (possibly moved) live stop.
  let risk: Dec | null = null;
  let riskReason = '';
  if (t.initialStopLoss === null) {
    riskReason = 'no initial stop-loss recorded for this trade';
  } else if (!positive(t.initialStopLoss)) {
    riskReason = 'initial stop-loss is invalid';
  } else {
    const candidate = entry.minus(new Dec(t.initialStopLoss)).abs().times(size);
    if (candidate.isZero()) riskReason = 'entry price equals the initial stop (zero risk)';
    else risk = candidate;
  }

  const grossR = risk === null ? null : gross.div(risk);
  const netR = risk === null || feesExcluded ? null : net.div(risk);

  const outcome: Outcome = net.gt(0) ? 'win' : net.lt(0) ? 'loss' : 'breakeven';

  const result: TradeResult = {
    tradeId: t.id,
    closedAt: closed.toISOString(),
    grossPnl: exact(gross),
    feesApplied: exact(feesApplied),
    feesExcluded,
    netPnl: exact(net),
    outcome,
    initialRisk: risk === null ? none(riskReason) : some(exact(risk)),
    grossR: grossR === null ? none(riskReason) : some(fixed(grossR, PRECISION.ratio)),
    netR:
      netR !== null
        ? some(fixed(netR, PRECISION.ratio))
        : none(
            risk === null
              ? riskReason
              : 'fees are in a different currency than the trade, so net R is not available',
          ),
  };

  return {
    ok: true,
    calc: { id: t.id, closedMs: closed.getTime(), trade: t, gross, net, grossR, netR, result },
  };
}

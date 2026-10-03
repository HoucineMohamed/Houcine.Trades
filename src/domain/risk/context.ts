import type { CurrencyStats } from '../stats';
import { analyzeEquityFrom } from '../stats';
import { Dec, isDecimalString } from '../money/decimal';
import {
  parsePendingJson,
  parseSettingsJson,
  settleSettings,
  type RiskField,
  type RiskSettings,
} from './settings';
import { DAY_MS, isInUtcDay, nextUtcMidnight, utcDayStart } from './time';
import type { OpenTradeRisk } from './types';

/**
 * Builds the risk context (equity, day figures, halts) from raw facts. PURE: the same inputs
 * always give the same context, so a halt can never be lost by a restart.
 *
 * Equity = starting balance + net realised P&L from the stats engine (unrealised P&L of open
 * trades is NOT counted: there are no live prices yet). Equity exists only in the account base
 * currency.
 */

export type HaltKind = 'daily_loss' | 'drawdown' | 'manual';

export const RISK_EVENT_KINDS = [
  'halt',
  'reset',
  'reset_refused',
  'plan_refused',
  'override',
  'settings_change',
  'settings_applied',
] as const;
export type RiskEventKind = (typeof RISK_EVENT_KINDS)[number];

export interface RiskEventRecord {
  id: number;
  kind: RiskEventKind;
  haltKind: HaltKind | null;
  createdAt: string;
  details: Record<string, unknown>;
}

/** After a drawdown halt begins, a manual reset is only possible this long afterwards. */
export const DRAWDOWN_RESET_DELAY_MS = DAY_MS;

export interface ActiveHalt {
  kind: HaltKind;
  message: string;
  /** When the halt began (null for daily-loss, which has no single start). */
  since: string | null;
  /** Daily-loss only: the next UTC midnight, when it clears by itself. */
  clearsAt: string | null;
  /** Drawdown / manual: whether your manual reset is allowed right now. */
  resetAllowedNow: boolean;
  /** Drawdown only: the earliest time a reset is possible. */
  resetAvailableAt: string | null;
  /** Drawdown only: milliseconds left until a reset is possible (0 when allowed). */
  resetRemainingMs: number | null;
}

/** Something the data layer should record in the append-only event log. */
export type NewHaltEvent =
  | { kind: 'drawdown'; beganAt: string; details: Record<string, unknown> }
  | { kind: 'daily_loss'; day: string; details: Record<string, unknown> };

export interface RiskContextInput {
  now: Date;
  account: { baseCurrency: string; startingBalance: string } | null;
  /** Stats-engine group for the base currency (null when it cannot be produced). */
  baseStats: CurrencyStats | null;
  /** Time each closed trade was RECORDED as closed (see risk-rules.md, backdated closes). */
  recordedClosedAt: Record<number, string | null>;
  openTrades: OpenTradeRisk[];
  /** This account's halt and reset events. */
  events: RiskEventRecord[];
  settingsJson: string | null;
  pendingJson: string | null;
}

export interface RiskContext {
  now: string;
  accountKnown: boolean;
  baseCurrency: string | null;
  /** Current equity, or null with `equityProblem`. */
  equity: string | null;
  equityProblem: string | null;
  /** Equity at the start of the UTC day, or null with `dayStartProblem`. */
  dayStartEquity: string | null;
  dayStartProblem: string | null;
  dayStart: string;
  /** Net realised P&L counted as "today" (see risk-rules.md): exact text. */
  todayNetPnl: string;
  /** Peak equity since the last drawdown baseline, and the current fall from it. */
  peakEquity: string | null;
  baselineEquity: string | null;
  fallFromPeak: string | null;
  settings: RiskSettings | null;
  settingsProblem: string | null;
  /** Pending loosening changes that have become effective and should now be saved. */
  becameEffective: { field: RiskField; from: string | number; to: string | number }[];
  openTrades: OpenTradeRisk[];
  halts: ActiveHalt[];
  newHaltEvents: NewHaltEvent[];
  /** Closed base-currency trades whose foreign-currency fees were left out of equity. */
  tradesWithExcludedFees: number;
}

const byId = (a: RiskEventRecord, b: RiskEventRecord) => a.id - b.id;

function lastEvent(
  events: RiskEventRecord[],
  kind: RiskEventKind,
  haltKind: HaltKind,
): RiskEventRecord | undefined {
  return [...events]
    .filter((e) => e.kind === kind && e.haltKind === haltKind)
    .sort(byId)
    .at(-1);
}

/** The latched halt of this kind that no later reset has cleared (by event order). */
function latchedHalt(events: RiskEventRecord[], haltKind: HaltKind): RiskEventRecord | undefined {
  const halt = lastEvent(events, 'halt', haltKind);
  if (!halt) return undefined;
  const reset = lastEvent(events, 'reset', haltKind);
  return reset && reset.id > halt.id ? undefined : halt;
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null;

export function buildRiskContext(input: RiskContextInput): RiskContext {
  const { now } = input;
  const dayStartDate = utcDayStart(now);
  const events = [...input.events].sort(byId);

  const base: RiskContext = {
    now: now.toISOString(),
    accountKnown: input.account !== null,
    baseCurrency: input.account?.baseCurrency ?? null,
    equity: null,
    equityProblem: null,
    dayStartEquity: null,
    dayStartProblem: null,
    dayStart: dayStartDate.toISOString(),
    todayNetPnl: '0',
    peakEquity: null,
    baselineEquity: null,
    fallFromPeak: null,
    settings: null,
    settingsProblem: null,
    becameEffective: [],
    openTrades: input.openTrades,
    halts: [],
    newHaltEvents: [],
    tradesWithExcludedFees: 0,
  };

  // ---- settings (fail closed when missing, unreadable or above a ceiling) ------------------
  const active = parseSettingsJson(input.settingsJson);
  const pending = parsePendingJson(input.pendingJson);
  let detection: RiskSettings | null = null; // the TIGHTEST limits, used to detect halts
  if (!active.ok) base.settingsProblem = active.problem;
  else if (!pending.ok) base.settingsProblem = pending.problem;
  else {
    const settled = settleSettings(active.settings, pending.pending, now);
    base.settings = settled.settings;
    base.becameEffective = settled.becameEffective;
    // Halts are detected with the stored (pre-pending) limits as well, so a limit that is about
    // to be loosened can never hide a breach that already happened.
    detection = {
      ...settled.settings,
      maxDailyLossPercent: minPercent(
        active.settings.maxDailyLossPercent,
        settled.settings.maxDailyLossPercent,
      ),
      maxDrawdownPercent: minPercent(
        active.settings.maxDrawdownPercent,
        settled.settings.maxDrawdownPercent,
      ),
    };
  }

  // ---- equity -------------------------------------------------------------------------------
  if (input.account === null) {
    base.equityProblem = 'The account does not exist.';
    return { ...base, halts: manualHalt(events, now) };
  }
  const stats = input.baseStats;
  if (stats === null) {
    base.equityProblem = 'Equity could not be calculated for the account currency.';
    return { ...base, halts: [...manualHalt(events, now)] };
  }
  base.tradesWithExcludedFees = stats.overall.flags.tradesWithExcludedFees;
  const curve = stats.equityCurve;
  if (!curve.startsFromAccountBalance) {
    base.equityProblem =
      'The account starting balance is missing or invalid, so equity cannot be verified.';
  } else if (stats.skipped.length > 0) {
    base.equityProblem = `${stats.skipped.length} closed trade(s) could not be calculated (${stats.skipped
      .map((s) => `#${s.tradeId}`)
      .join(', ')}), so equity cannot be verified.`;
  } else if (new Dec(curve.endingEquity).lte(0)) {
    base.equityProblem = 'Equity is zero or negative.';
  } else {
    base.equity = curve.endingEquity;
  }
  if (base.equityProblem) {
    return { ...base, halts: [...manualHalt(events, now), ...latchedDrawdown(events, now)] };
  }

  // ---- the UTC day: which closed trades count as "today" -----------------------------------
  // A trade counts toward today when EITHER its closed time OR the time it was recorded as
  // closed in the journal falls on today's UTC day. A loss backdated to yesterday but entered
  // today therefore still counts. Day-start equity only includes trades that are in neither.
  let todayNet = new Dec(0);
  let beforeNet = new Dec(0);
  for (const r of stats.tradeResults) {
    const recorded = input.recordedClosedAt[r.tradeId] ?? r.closedAt;
    const today = isInUtcDay(r.closedAt, dayStartDate) || isInUtcDay(recorded, dayStartDate);
    const before =
      new Date(r.closedAt).getTime() < dayStartDate.getTime() &&
      new Date(recorded).getTime() < dayStartDate.getTime();
    if (today) todayNet = todayNet.plus(r.netPnl);
    else if (before) beforeNet = beforeNet.plus(r.netPnl);
  }
  base.todayNetPnl = todayNet.isZero() ? '0' : todayNet.toFixed();
  const dayStartEquity = new Dec(curve.startingEquity).plus(beforeNet);
  if (dayStartEquity.lte(0))
    base.dayStartProblem = 'Equity at the start of the day is zero or negative.';
  else base.dayStartEquity = dayStartEquity.toFixed();

  // ---- drawdown since the last manual reset ------------------------------------------------
  const reset = lastEvent(events, 'reset', 'drawdown');
  let baselineEquity = curve.startingEquity;
  let afterBaseline = stats.tradeResults;
  if (reset) {
    const stored = reset.details.baselineEquity;
    if (typeof stored !== 'string' || !isDecimalString(stored)) {
      base.equityProblem = 'The stored drawdown baseline is corrupt, so equity cannot be verified.';
      base.equity = null;
      return { ...base, halts: [...manualHalt(events, now), ...latchedDrawdown(events, now)] };
    }
    baselineEquity = stored;
    const resetMs = new Date(reset.createdAt).getTime();
    afterBaseline = stats.tradeResults.filter(
      (r) => new Date(input.recordedClosedAt[r.tradeId] ?? r.closedAt).getTime() > resetMs,
    );
  }
  const walk = analyzeEquityFrom(
    baselineEquity,
    afterBaseline.map((r) => ({ tradeId: r.tradeId, closedAt: r.closedAt, netPnl: r.netPnl })),
  ).curve;
  base.baselineEquity = baselineEquity;
  base.peakEquity = walk.peakEquity;
  base.fallFromPeak = walk.points.at(-1)?.fallFromPeak ?? '0';

  const halts: ActiveHalt[] = [];

  // ---- drawdown halt: derived breach OR a latched event, until a manual reset ---------------
  const latched = latchedHalt(events, 'drawdown');
  let breachBeganAt: string | null = null;
  if (detection) {
    const limit = detection.maxDrawdownPercent;
    const breach = walk.points.find(
      (p) =>
        new Dec(p.peak).gt(0) &&
        new Dec(p.fallFromPeak).times(100).gte(new Dec(p.peak).times(limit)),
    );
    if (breach) {
      breachBeganAt = isoOrNull(input.recordedClosedAt[breach.tradeId]) ?? breach.closedAt;
    }
  }
  if (latched || breachBeganAt) {
    const beganAt =
      isoOrNull(latched?.details.beganAt) ?? latched?.createdAt ?? (breachBeganAt as string);
    const availableAt = new Date(new Date(beganAt).getTime() + DRAWDOWN_RESET_DELAY_MS);
    const remaining = Math.max(0, availableAt.getTime() - now.getTime());
    halts.push({
      kind: 'drawdown',
      message: `Trading is halted: equity fell ${detection?.maxDrawdownPercent ?? 'the allowed'}% or more from its peak. Only a manual reset can lift this, and not before 24 hours have passed.`,
      since: beganAt,
      clearsAt: null,
      resetAllowedNow: remaining === 0,
      resetAvailableAt: availableAt.toISOString(),
      resetRemainingMs: remaining,
    });
    if (!latched && breachBeganAt) {
      base.newHaltEvents.push({
        kind: 'drawdown',
        beganAt: breachBeganAt,
        details: {
          beganAt: breachBeganAt,
          limitPercent: detection?.maxDrawdownPercent ?? null,
          peakEquity: walk.peakEquity,
          equity: walk.endingEquity,
          baselineEquity,
        },
      });
    }
  }

  // ---- manual halt ---------------------------------------------------------------------------
  halts.push(...manualHalt(events, now));

  // ---- daily-loss halt (derived; clears itself at the next UTC midnight) ---------------------
  if (detection && base.dayStartEquity !== null) {
    const loss = todayNet.isNegative() ? todayNet.abs() : new Dec(0);
    if (
      loss.gt(0) &&
      loss.times(100).gte(new Dec(base.dayStartEquity).times(detection.maxDailyLossPercent))
    ) {
      halts.push({
        kind: 'daily_loss',
        message: `Trading is halted for today: today's realised loss (${loss.toFixed()}) reached ${detection.maxDailyLossPercent}% of the equity at the start of the UTC day. It clears at the next UTC midnight.`,
        since: null,
        clearsAt: nextUtcMidnight(now).toISOString(),
        resetAllowedNow: false,
        resetAvailableAt: null,
        resetRemainingMs: null,
      });
      const day = dayStartDate.toISOString().slice(0, 10);
      const logged = events.some(
        (e) => e.kind === 'halt' && e.haltKind === 'daily_loss' && e.details.day === day,
      );
      if (!logged) {
        base.newHaltEvents.push({
          kind: 'daily_loss',
          day,
          details: {
            day,
            loss: loss.toFixed(),
            dayStartEquity: base.dayStartEquity,
            limitPercent: detection.maxDailyLossPercent,
          },
        });
      }
    }
  }

  return { ...base, halts };
}

function minPercent(a: string, b: string): string {
  return new Dec(a).lte(b) ? a : b;
}

function manualHalt(events: RiskEventRecord[], now: Date): ActiveHalt[] {
  void now;
  const latched = latchedHalt(events, 'manual');
  if (!latched) return [];
  return [
    {
      kind: 'manual',
      message: `Trading is halted manually${typeof latched.details.reason === 'string' ? `: ${latched.details.reason}` : ''}. Only a manual reset can lift this.`,
      since: latched.createdAt,
      clearsAt: null,
      resetAllowedNow: true, // manual halts can be reset immediately
      resetAvailableAt: latched.createdAt,
      resetRemainingMs: 0,
    },
  ];
}

/** A latched drawdown halt still stands even when equity itself cannot be verified. */
function latchedDrawdown(events: RiskEventRecord[], now: Date): ActiveHalt[] {
  const latched = latchedHalt(events, 'drawdown');
  if (!latched) return [];
  const beganAt = isoOrNull(latched.details.beganAt) ?? latched.createdAt;
  const availableAt = new Date(new Date(beganAt).getTime() + DRAWDOWN_RESET_DELAY_MS);
  const remaining = Math.max(0, availableAt.getTime() - now.getTime());
  return [
    {
      kind: 'drawdown',
      message:
        'Trading is halted after a drawdown. Only a manual reset can lift this, and not before 24 hours have passed.',
      since: beganAt,
      clearsAt: null,
      resetAllowedNow: remaining === 0,
      resetAvailableAt: availableAt.toISOString(),
      resetRemainingMs: remaining,
    },
  ];
}

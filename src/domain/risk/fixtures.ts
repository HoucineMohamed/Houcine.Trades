import { computeAccountStats } from '../stats';
import { input as statsInput, trade as statsTrade } from '../stats/fixtures';
import type { StatsTrade } from '../stats';
import {
  buildRiskContext,
  type RiskContext,
  type RiskContextInput,
  type RiskEventRecord,
} from './context';
import { RISK_DEFAULTS, type RiskSettings } from './settings';
import type { OpenTradeRisk, TradePlan } from './types';

/** A healthy context: USDT account with 10000 equity, default settings, nothing open, no halts. */
export function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: '2026-03-10T15:00:00.000Z',
    accountKnown: true,
    baseCurrency: 'USDT',
    equity: '10000',
    equityProblem: null,
    dayStartEquity: '10000',
    dayStartProblem: null,
    dayStart: '2026-03-10T00:00:00.000Z',
    todayNetPnl: '0',
    peakEquity: '10000',
    baselineEquity: '10000',
    fallFromPeak: '0',
    settings: { ...RISK_DEFAULTS },
    settingsProblem: null,
    becameEffective: [],
    openTrades: [],
    halts: [],
    newHaltEvents: [],
    tradesWithExcludedFees: 0,
    ...over,
  };
}

export function withSettings(over: Partial<RiskSettings>): RiskSettings {
  return { ...RISK_DEFAULTS, ...over };
}

export function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: 'BTCUSDT',
    direction: 'long',
    entry: '100',
    stop: '95',
    target: '115',
    size: '20',
    quoteCurrency: 'USDT',
    ...over,
  };
}

export function openTrade(over: Partial<OpenTradeRisk> & { tradeId: number }): OpenTradeRisk {
  return {
    quoteCurrency: 'USDT',
    entryPrice: '100',
    initialStopLoss: '95',
    size: '20',
    ...over,
  };
}

/**
 * A closed trade that made exactly `pnl` (entry 100000, size 1, long, so losses up to 99999 are
 * possible). `closedAt` is when it closed; the time it was recorded as closed is set separately.
 */
export function pnlTrade(id: number, pnl: string, closedAt: string): StatsTrade {
  const negative = pnl.startsWith('-');
  const abs = negative ? pnl.slice(1) : pnl;
  // exit = 100000 + pnl, computed with BigInt on the digits (no floats)
  const exit = negative ? subtractFrom100000(abs) : addTo100000(abs);
  return statsTrade({
    id,
    entryPrice: '100000',
    exitPrice: exit,
    size: '1',
    initialStopLoss: '90000',
    closedAt,
  });
}

// 100000 + x and 100000 - x for decimals, done with strings through BigInt (no floats).
function scale(x: string): { n: bigint; places: number } {
  const [i, f = ''] = x.split('.');
  return { n: BigInt(i + f), places: f.length };
}
function fmt(n: bigint, places: number): string {
  const s = n.toString().padStart(places + 1, '0');
  const cut = s.length - places;
  const text = places === 0 ? s : `${s.slice(0, cut)}.${s.slice(cut)}`;
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
function addTo100000(x: string): string {
  const { n, places } = scale(x);
  return fmt(100000n * 10n ** BigInt(places) + n, places);
}
function subtractFrom100000(x: string): string {
  const { n, places } = scale(x);
  return fmt(100000n * 10n ** BigInt(places) - n, places);
}

export interface BuildOptions {
  now?: string;
  trades?: StatsTrade[];
  /** tradeId -> time recorded as closed (default: the trade's closedAt). */
  recorded?: Record<number, string | null>;
  openTrades?: OpenTradeRisk[];
  events?: RiskEventRecord[];
  settingsJson?: string | null;
  pendingJson?: string | null;
  startingBalance?: string;
  baseCurrency?: string;
  noAccount?: boolean;
}

/** Builds a real context through the stats engine and the risk engine. */
export function buildContext(opts: BuildOptions = {}): RiskContext {
  const trades = opts.trades ?? [];
  const base = opts.baseCurrency ?? 'USDT';
  const stats = computeAccountStats(
    statsInput(trades, { baseCurrency: base, startingBalance: opts.startingBalance ?? '10000' }),
  );
  const recorded: Record<number, string | null> = {};
  for (const t of trades) recorded[t.id] = t.closedAt;
  Object.assign(recorded, opts.recorded ?? {});
  const input: RiskContextInput = {
    now: new Date(opts.now ?? '2026-03-10T15:00:00.000Z'),
    account: opts.noAccount
      ? null
      : { baseCurrency: base, startingBalance: opts.startingBalance ?? '10000' },
    baseStats: opts.noAccount
      ? null
      : (stats.currencies.find((c) => c.quoteCurrency === base) ?? null),
    recordedClosedAt: recorded,
    openTrades: opts.openTrades ?? [],
    events: opts.events ?? [],
    settingsJson:
      opts.settingsJson === undefined ? JSON.stringify(RISK_DEFAULTS) : opts.settingsJson,
    pendingJson: opts.pendingJson ?? '{}',
  };
  return buildRiskContext(input);
}

export function event(
  id: number,
  kind: RiskEventRecord['kind'],
  haltKind: RiskEventRecord['haltKind'],
  createdAt: string,
  details: Record<string, unknown> = {},
): RiskEventRecord {
  return { id, kind, haltKind, createdAt, details };
}

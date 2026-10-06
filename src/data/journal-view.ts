import { and, asc, eq } from 'drizzle-orm';
import {
  computeAccountStats,
  type AccountStats,
  type SkippedTrade,
  type TradeResult,
} from '@/domain/stats';
import {
  paginate,
  sortJournalRows,
  type JournalQuery,
  type Page,
  type SortableRow,
} from '@/domain/trades/table';
import { getAccount, type Account } from './accounts';
import type { Reader } from './client';
import { getTradeRiskFlags, type TradeRiskFlags } from './journal';
import { riskVerdicts, setups, trades, type RiskVerdictRow } from './schema';
import { loadStatsInput } from './stats';
import type { Trade } from './trades';

/**
 * Read-only views for the journal pages. They only LOAD rows and join the engine's results;
 * every number shown comes from the stats engine or the stored values (project rule 3).
 */

export interface JournalRow extends SortableRow {
  accountId: number;
  direction: string;
  assetClass: string;
  quoteCurrency: string;
  setupId: number | null;
  setupName: string | null;
  size: string;
  plannedEntry: string;
  entryPrice: string | null;
  exitPrice: string | null;
  stopLoss: string;
  overridden: boolean;
}

/** Net P&L and net R per closed trade id, straight from the stats engine. */
export function resultsByTrade(stats: AccountStats): Map<number, TradeResult> {
  const map = new Map<number, TradeResult>();
  for (const c of stats.currencies) for (const r of c.tradeResults) map.set(r.tradeId, r);
  return map;
}

export function skippedByTrade(stats: AccountStats): Map<number, SkippedTrade> {
  const map = new Map<number, SkippedTrade>();
  for (const c of stats.currencies) for (const s of c.skipped) map.set(s.tradeId, s);
  return map;
}

function setupNames(db: Reader): Map<number, string> {
  return new Map(
    db
      .select({ id: setups.id, name: setups.name })
      .from(setups)
      .orderBy(asc(setups.name))
      .all()
      .map((s) => [s.id, s.name]),
  );
}

export interface JournalView {
  page: Page<JournalRow>;
  /** How many trades the account has before filtering. */
  totalAll: number;
  setups: { id: number; name: string }[];
}

export function listJournal(db: Reader, accountId: number, query: JournalQuery): JournalView {
  const names = setupNames(db);
  const results = resultsByTrade(computeAccountStats(loadStatsInput(db, accountId)));
  const flags = getTradeRiskFlags(db);
  const all: JournalRow[] = db
    .select()
    .from(trades)
    .where(eq(trades.accountId, accountId))
    .all()
    .map((t) => ({
      id: t.id,
      accountId: t.accountId,
      createdAt: t.createdAt,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      symbol: t.symbol,
      status: t.status,
      direction: t.direction,
      assetClass: t.assetClass,
      quoteCurrency: t.quoteCurrency,
      setupId: t.setupId,
      setupName: t.setupId === null ? null : (names.get(t.setupId) ?? null),
      size: t.size,
      plannedEntry: t.plannedEntry,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      stopLoss: t.stopLoss,
      netPnl: results.get(t.id)?.netPnl ?? null,
      netR: results.get(t.id)?.netR.value ?? null,
      overridden: flags.get(t.id)?.overridden ?? false,
    }));

  const wanted = query.symbol?.toUpperCase() ?? null;
  const filtered = all.filter(
    (r) =>
      (query.status === null || r.status === query.status) &&
      (query.direction === null || r.direction === query.direction) &&
      (wanted === null || r.symbol.toUpperCase() === wanted) &&
      (query.setupId === null || r.setupId === query.setupId) &&
      (!query.overrideOnly || r.overridden),
  );
  return {
    page: paginate(sortJournalRows(filtered, query.sort, query.dir), query.page),
    totalAll: all.length,
    setups: [...names].map(([id, name]) => ({ id, name })),
  };
}

// ---- one trade ---------------------------------------------------------------------------------------

export interface VerdictView {
  id: number;
  stage: string;
  approved: boolean;
  createdAt: string;
  overrideReason: string | null;
  violations: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  numbers: Record<string, unknown> | null;
}

export interface TradeDetail {
  trade: Trade;
  account: Account;
  setupName: string | null;
  /** From the stats engine; null for trades that are not closed or could not be calculated. */
  result: TradeResult | null;
  skipped: SkippedTrade | null;
  flags: TradeRiskFlags;
  verdicts: VerdictView[];
}

const asList = (v: unknown): { code: string; message: string }[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is { code: string; message: string } => !!x && typeof x.code === 'string')
        .map((x) => ({ code: x.code, message: String(x.message ?? '') }))
    : [];

/** Reads a stored verdict snapshot defensively: damaged JSON shows as "no details", never a crash. */
export function parseVerdict(row: RiskVerdictRow): VerdictView {
  let snapshot: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(row.snapshotJson);
    snapshot = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    snapshot = null;
  }
  const numbers = snapshot?.numbers;
  return {
    id: row.id,
    stage: row.stage,
    approved: row.approved === 1,
    createdAt: row.createdAt,
    overrideReason: row.overrideReason,
    violations: asList(snapshot?.violations),
    warnings: asList(snapshot?.warnings),
    numbers: numbers && typeof numbers === 'object' ? (numbers as Record<string, unknown>) : null,
  };
}

export function loadTradeDetail(db: Reader, tradeId: number): TradeDetail | null {
  const trade = db.select().from(trades).where(eq(trades.id, tradeId)).get();
  if (!trade) return null;
  const account = getAccount(db, trade.accountId);
  if (!account) return null;
  const stats = computeAccountStats(loadStatsInput(db, trade.accountId));
  const flags = getTradeRiskFlags(db).get(tradeId) ?? {
    overridden: false,
    overrideReasons: [],
    violationCodes: [],
  };
  const verdicts = db
    .select()
    .from(riskVerdicts)
    .where(and(eq(riskVerdicts.tradeId, tradeId)))
    .orderBy(asc(riskVerdicts.id))
    .all()
    .map(parseVerdict);
  return {
    trade,
    account,
    setupName: trade.setupId === null ? null : (setupNames(db).get(trade.setupId) ?? null),
    result: resultsByTrade(stats).get(tradeId) ?? null,
    skipped: skippedByTrade(stats).get(tradeId) ?? null,
    flags,
    verdicts,
  };
}

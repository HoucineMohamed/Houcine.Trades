import { and, desc, eq, type SQL } from 'drizzle-orm';
import { assertAccountModeAllowed } from '@/domain/accounts/account';
import { getEnv } from '@/config/env';
import { parseWith, ValidationError } from '@/domain/errors';
import { tradeFilterSchema, type TradeFilter } from '@/domain/trades/inputs';
import * as lifecycle from '@/domain/trades/lifecycle';
import type { TradeFields } from '@/domain/trades/types';
import { getAccount, type RepoOptions } from './accounts';
import type { Db, Writer } from './client';
import { NotFoundError } from './errors';
import { trades, type TradeRow } from './schema';

/** A stored trade: the domain fields plus bookkeeping columns such as closedRecordedAt. */
export type Trade = TradeRow;
import { getSetup } from './setups';

/**
 * Trade repository. Every write goes through the pure domain rules first (src/domain/trades),
 * so an invalid trade can never reach the database. Writes run inside a transaction.
 */

const clock = (options: RepoOptions) => (options.now ?? (() => new Date()))();

/** Inserts a new trade inside an existing transaction (the journal uses this to add a verdict atomically). */
export function createTradeIn(tx: Writer, input: unknown, options: RepoOptions = {}): Trade {
  const fields = lifecycle.buildNewTrade(input);
  const account = getAccount(tx, fields.accountId);
  if (!account) {
    throw new ValidationError([{ field: 'accountId', message: 'Account not found' }]);
  }
  assertAccountModeAllowed(account.mode, options.tradingMode ?? getEnv().TRADING_MODE);
  if (fields.setupId !== null && !getSetup(tx, fields.setupId)) {
    throw new ValidationError([{ field: 'setupId', message: 'Setup not found' }]);
  }
  const stamp = clock(options).toISOString();
  return tx
    .insert(trades)
    .values({ ...fields, createdAt: stamp, updatedAt: stamp })
    .returning()
    .get();
}

/**
 * Low-level create: NO risk check. The UI must use the journal (src/data/journal.ts), which
 * evaluates the plan first; an ESLint rule keeps src/app from importing this.
 */
export function createTrade(db: Db, input: unknown, options: RepoOptions = {}): Trade {
  return db.transaction((tx) => createTradeIn(tx, input, options));
}

export function getTrade(db: Db, id: number): Trade | undefined {
  return db.select().from(trades).where(eq(trades.id, id)).get();
}

/** Newest first. Filters: accountId, status, symbol (exact, case-insensitive). */
export function listTrades(db: Db, filter: TradeFilter = {}): Trade[] {
  const f = parseWith(tradeFilterSchema, filter);
  const conditions: SQL[] = [];
  if (f.accountId !== undefined) conditions.push(eq(trades.accountId, f.accountId));
  if (f.status !== undefined) conditions.push(eq(trades.status, f.status));
  if (f.symbol !== undefined) conditions.push(eq(trades.symbol, f.symbol));
  return db
    .select()
    .from(trades)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(trades.createdAt), desc(trades.id))
    .all();
}

/** Loads the trade, applies a pure domain change, saves it (inside the given transaction). */
function changeIn(
  tx: Writer,
  id: number,
  options: RepoOptions,
  transform: (current: Trade) => TradeFields,
  extra: (stamp: string) => Partial<typeof trades.$inferInsert> = () => ({}),
): Trade {
  const current = tx.select().from(trades).where(eq(trades.id, id)).get();
  if (!current) throw new NotFoundError(`Trade ${id}`);
  const next = transform(current);
  const stamp = clock(options).toISOString();
  return tx
    .update(trades)
    .set({ ...next, ...extra(stamp), updatedAt: stamp })
    .where(eq(trades.id, id))
    .returning()
    .get();
}

const change = (
  db: Db,
  id: number,
  options: RepoOptions,
  transform: (current: Trade) => TradeFields,
  extra?: (stamp: string) => Partial<typeof trades.$inferInsert>,
): Trade => db.transaction((tx) => changeIn(tx, id, options, transform, extra));

/** Low-level planned -> open: NO risk check (see createTrade). Input: { entryPrice, openedAt }. */
export function openTradeIn(
  tx: Writer,
  id: number,
  input: unknown,
  options: RepoOptions = {},
): Trade {
  return changeIn(tx, id, options, (current) => lifecycle.openTrade(current, input));
}

export function openTrade(db: Db, id: number, input: unknown, options: RepoOptions = {}): Trade {
  return db.transaction((tx) => openTradeIn(tx, id, input, options));
}

/**
 * open -> closed. Input: { exitPrice, closedAt, fees?, feesCurrency?, reviewNotes?, emotion? }.
 * Also records WHEN the close was entered in the journal (closed_recorded_at, frozen afterwards),
 * which the risk engine uses so a backdated loss still counts toward today.
 * Closing is never blocked by risk rules: it only reduces risk.
 */
export function closeTrade(db: Db, id: number, input: unknown, options: RepoOptions = {}): Trade {
  return change(
    db,
    id,
    options,
    (current) => lifecycle.closeTrade(current, input),
    (stamp) => ({
      closedRecordedAt: stamp,
    }),
  );
}

/** planned -> cancelled. */
export function cancelTrade(db: Db, id: number, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.cancelTrade(current));
}

/** Edit with the per-status locks (see editableFields in the domain). */
export function updateTrade(db: Db, id: number, patch: unknown, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.editTrade(current, patch));
}

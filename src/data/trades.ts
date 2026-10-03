import { and, desc, eq, type SQL } from 'drizzle-orm';
import { assertAccountModeAllowed } from '@/domain/accounts/account';
import { getEnv } from '@/config/env';
import { parseWith, ValidationError } from '@/domain/errors';
import { tradeFilterSchema, type TradeFilter } from '@/domain/trades/inputs';
import * as lifecycle from '@/domain/trades/lifecycle';
import type { Trade, TradeFields } from '@/domain/trades/types';
import { getAccount, type RepoOptions } from './accounts';
import type { Db } from './client';
import { NotFoundError } from './errors';
import { trades } from './schema';
import { getSetup } from './setups';

/**
 * Trade repository. Every write goes through the pure domain rules first (src/domain/trades),
 * so an invalid trade can never reach the database. Writes run inside a transaction.
 */

const clock = (options: RepoOptions) => (options.now ?? (() => new Date()))();

export function createTrade(db: Db, input: unknown, options: RepoOptions = {}): Trade {
  const fields = lifecycle.buildNewTrade(input);
  return db.transaction((tx) => {
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
  });
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

/** Loads the trade, applies a pure domain change, saves it. All inside one transaction. */
function change(
  db: Db,
  id: number,
  options: RepoOptions,
  transform: (current: Trade) => TradeFields,
): Trade {
  return db.transaction((tx) => {
    const current = tx.select().from(trades).where(eq(trades.id, id)).get();
    if (!current) throw new NotFoundError(`Trade ${id}`);
    const next = transform(current);
    return tx
      .update(trades)
      .set({ ...next, updatedAt: clock(options).toISOString() })
      .where(eq(trades.id, id))
      .returning()
      .get();
  });
}

/** planned -> open. Input: { entryPrice, openedAt }. */
export function openTrade(db: Db, id: number, input: unknown, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.openTrade(current, input));
}

/** open -> closed. Input: { exitPrice, closedAt, fees?, feesCurrency?, reviewNotes?, emotion? }. */
export function closeTrade(db: Db, id: number, input: unknown, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.closeTrade(current, input));
}

/** planned -> cancelled. */
export function cancelTrade(db: Db, id: number, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.cancelTrade(current));
}

/** Edit with the per-status locks (see editableFields in the domain). */
export function updateTrade(db: Db, id: number, patch: unknown, options: RepoOptions = {}): Trade {
  return change(db, id, options, (current) => lifecycle.editTrade(current, patch));
}

import { and, asc, eq } from 'drizzle-orm';
import type { StatsInput } from '@/domain/stats';
import { getAccount } from './accounts';
import type { Db } from './client';
import { NotFoundError } from './errors';
import { setups, trades } from './schema';

/**
 * Loads what the stats engine needs for one account: the account's starting balance and its
 * CLOSED trades, as plain objects. There is deliberately no calculation here (project rule 3):
 * all maths lives in src/domain/stats.
 */
export function loadStatsInput(db: Db, accountId: number): StatsInput {
  const account = getAccount(db, accountId);
  if (!account) throw new NotFoundError(`Account ${accountId}`);

  const rows = db
    .select({
      id: trades.id,
      symbol: trades.symbol,
      assetClass: trades.assetClass,
      direction: trades.direction,
      quoteCurrency: trades.quoteCurrency,
      entryPrice: trades.entryPrice,
      exitPrice: trades.exitPrice,
      size: trades.size,
      initialStopLoss: trades.initialStopLoss,
      fees: trades.fees,
      feesCurrency: trades.feesCurrency,
      closedAt: trades.closedAt,
      setupId: trades.setupId,
      setupName: setups.name,
    })
    .from(trades)
    .leftJoin(setups, eq(trades.setupId, setups.id))
    .where(and(eq(trades.accountId, accountId), eq(trades.status, 'closed')))
    .orderBy(asc(trades.closedAt), asc(trades.id))
    .all();

  return {
    account: {
      id: account.id,
      name: account.name,
      baseCurrency: account.baseCurrency,
      startingBalance: account.startingBalance,
    },
    trades: rows,
  };
}

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createAccount } from '@/data/accounts';
import type { Db } from '@/data/client';
import { closeTrade, createTrade } from '@/data/trades';
import { memoryDb } from './db';

/** A fresh in-memory database with one USDT account (starting balance 10000). */
export function riskDb(): Db {
  const db = memoryDb();
  createAccount(
    db,
    { name: 'Paper', baseCurrency: 'USDT', startingBalance: '10000' },
    { now: () => new Date('2026-01-01T00:00:00Z') },
  );
  return db;
}

/**
 * Simulates restarting the application: the database is copied byte for byte into a brand-new
 * in-memory connection (no file is created). Nothing but what is stored survives.
 */
export function restartDb(db: Db): Db {
  const sqlite = new Database(db.$client.serialize());
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}

/**
 * Logs a closed long trade that made exactly `pnl` (entry 100000, size 1). `closedAt` is the
 * time you say it closed; `recordedAt` (default: the same) is when the journal recorded it.
 */
export function closedTrade(
  db: Db,
  o: { pnl: number; closedAt: string; recordedAt?: string; accountId?: number },
) {
  const accountId = o.accountId ?? 1;
  const trade = createTrade(
    db,
    {
      accountId,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100000',
      stopLoss: '90000',
      size: '1',
      quoteCurrency: 'USDT',
      entryPrice: '100000',
      openedAt: '2026-01-01T00:00:00Z',
    },
    { now: () => new Date('2026-01-01T00:00:00Z') },
  );
  return closeTrade(
    db,
    trade.id,
    { exitPrice: String(100000 + o.pnl), closedAt: o.closedAt },
    { now: () => new Date(o.recordedAt ?? o.closedAt) },
  );
}

export const at = (iso: string) => new Date(iso);

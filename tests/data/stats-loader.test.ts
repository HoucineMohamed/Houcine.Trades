import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import type { Db } from '@/data/client';
import { NotFoundError } from '@/data/errors';
import { createSetup } from '@/data/setups';
import { loadStatsInput } from '@/data/stats';
import { cancelTrade, closeTrade, createTrade, openTrade, updateTrade } from '@/data/trades';
import { computeAccountStats } from '@/domain/stats';
import { memoryDb } from '../helpers/db';

const input = (over: Record<string, unknown> = {}) => ({
  accountId: 1,
  symbol: 'BTCUSDT',
  assetClass: 'crypto',
  direction: 'long',
  plannedEntry: '100',
  stopLoss: '95',
  takeProfit: '120',
  size: '2',
  quoteCurrency: 'USDT',
  ...over,
});
const OPEN = { entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' };
const CLOSE = { exitPrice: '110', closedAt: '2026-10-01T12:00:00Z' };

let db: Db;
beforeEach(() => {
  db = memoryDb();
  createAccount(db, { name: 'Paper', baseCurrency: 'USDT', startingBalance: '1000' });
});

describe('loadStatsInput', () => {
  it('returns the account balance and only CLOSED trades of that account', () => {
    createAccount(db, { name: 'Other', baseCurrency: 'USD', startingBalance: '5' });
    // account 1: planned, open, closed, cancelled
    createTrade(db, input()); // 1 planned
    createTrade(db, input({ status: 'open', ...OPEN })); // 2 open
    createTrade(db, input({ status: 'open', ...OPEN })); // 3 -> closed
    closeTrade(db, 3, CLOSE);
    createTrade(db, input()); // 4 -> cancelled
    cancelTrade(db, 4);
    // account 2: one closed trade that must NOT appear
    createTrade(db, input({ accountId: 2, status: 'open', ...OPEN })); // 5
    closeTrade(db, 5, CLOSE);

    const result = loadStatsInput(db, 1);
    expect(result.account).toEqual({
      id: 1,
      name: 'Paper',
      baseCurrency: 'USDT',
      startingBalance: '1000',
    });
    expect(result.trades.map((t) => t.id)).toEqual([3]);
    expect(result.trades[0]).toEqual({
      id: 3,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      quoteCurrency: 'USDT',
      entryPrice: '100',
      exitPrice: '110',
      size: '2',
      initialStopLoss: '95',
      fees: '0',
      feesCurrency: 'USDT',
      closedAt: '2026-10-01T12:00:00.000Z',
      setupId: null,
      setupName: null,
    });
  });

  it('joins the setup name', () => {
    const s = createSetup(db, { name: 'Breakout' });
    createTrade(db, input({ status: 'open', setupId: s.id, ...OPEN }));
    closeTrade(db, 1, CLOSE);
    expect(loadStatsInput(db, 1).trades[0]).toMatchObject({ setupId: s.id, setupName: 'Breakout' });
  });

  it('is empty for an account with no closed trades, and reports a missing account', () => {
    expect(loadStatsInput(db, 1).trades).toEqual([]);
    expect(() => loadStatsInput(db, 99)).toThrow(NotFoundError);
  });
});

describe('end to end: journal -> loader -> stats engine', () => {
  it('R uses the INITIAL stop even if the live stop was moved after opening', () => {
    // long, entry 100, planned stop 95, size 2. After opening the live stop is moved to 99.
    createTrade(db, input());
    openTrade(db, 1, OPEN);
    updateTrade(db, 1, { stopLoss: '99' });
    closeTrade(db, 1, CLOSE); // exit 110

    const c = computeAccountStats(loadStatsInput(db, 1)).currencies[0]!;
    // gross = (110 - 100) x 2 = 20. Initial risk = |100 - 95| x 2 = 10 -> R = 2.
    // (Using the moved stop 99 would give risk 2 and a wrong R of 10.)
    expect(c.tradeResults[0]).toMatchObject({ grossPnl: '20', netPnl: '20' });
    expect(c.tradeResults[0]!.initialRisk.value).toBe('10');
    expect(c.tradeResults[0]!.grossR.value).toBe('2.0000');
    expect(c.overall.netPnl).toBe('20');
    expect(c.equityCurve.points.map((p) => p.equity)).toEqual(['1020']);
  });

  it('keeps currencies apart and flags foreign fees using real stored trades', () => {
    createTrade(db, input({ status: 'open', fees: '1', ...OPEN })); // USDT, fees USDT
    closeTrade(db, 1, CLOSE); // gross 20, net 19
    createTrade(
      db,
      input({ status: 'open', quoteCurrency: 'EUR', feesCurrency: 'BNB', fees: '3', ...OPEN }),
    );
    closeTrade(db, 2, CLOSE); // gross 20, fees left out -> net 20, flagged

    const stats = computeAccountStats(loadStatsInput(db, 1));
    expect(stats.currencies.map((c) => [c.quoteCurrency, c.overall.netPnl])).toEqual([
      ['USDT', '19'],
      ['EUR', '20'],
    ]);
    expect(stats.currencies[1]!.overall.flags.tradesWithExcludedFees).toBe(1);
  });
});

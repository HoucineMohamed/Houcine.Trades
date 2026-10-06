import { describe, expect, it } from 'vitest';
import { loadDashboard, RECENT_CLOSED } from '@/data/dashboard';
import { NotFoundError } from '@/data/errors';
import { createTrade } from '@/data/trades';
import { at, closedTrade, riskDb } from '../helpers/risk';

const NOW = at('2026-03-10T15:00:00.000Z');
const openTrade = (db: ReturnType<typeof riskDb>, over: Record<string, unknown> = {}) =>
  createTrade(
    db,
    {
      accountId: 1,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100',
      entryPrice: '100',
      stopLoss: '95',
      size: '20',
      quoteCurrency: 'USDT',
      openedAt: '2026-03-10T09:00:00Z',
      ...over,
    },
    { now: () => at('2026-03-10T09:00:00.000Z') },
  );

describe('loadDashboard', () => {
  it('a new account: zero counts, a verified zero open risk, nothing invented', () => {
    const d = loadDashboard(riskDb(), 1, NOW);
    expect(d.counts).toEqual({ total: 0, planned: 0, open: 0, closed: 0 });
    expect(d.openTrades).toEqual([]);
    expect(d.recentClosed).toEqual([]);
    expect(d.stats.currencies).toHaveLength(1); // the base currency, with no trades yet
    expect(d.stats.currencies[0]?.overall.tradeCount).toBe(0);
    expect(d.risk.equity).toBe('10000');
    expect(d.usage.openRisk).toMatchObject({ used: '0', problem: null });
    expect(d.usage.dailyLoss).toMatchObject({ used: '0', limitAmount: '300' });
    expect(d.usage.openTrades).toEqual({ used: 0, limit: 3, reached: false });
  });

  it('shows the engines’ own numbers: equity, today, open risk, last closed trades newest first', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 200, closedAt: '2026-03-08T10:00:00.000Z' });
    closedTrade(db, { pnl: -100, closedAt: '2026-03-09T10:00:00.000Z' });
    closedTrade(db, { pnl: 50, closedAt: '2026-03-10T10:00:00.000Z' });
    openTrade(db);
    const d = loadDashboard(db, 1, NOW);
    expect(d.risk.equity).toBe('10150');
    expect(d.risk.todayNetPnl).toBe('50');
    expect(d.counts).toEqual({ total: 4, planned: 0, open: 1, closed: 3 });
    expect(d.recentClosed.map((t) => t.netPnl)).toEqual(['50', '-100', '200']);
    expect(d.openTrades).toHaveLength(1);
    expect(d.openTrades[0]?.risk).toEqual({ amount: '100', problem: null });
    expect(d.usage.openRisk).toMatchObject({ used: '100', usedPercent: '0.99' });
    expect(d.stats.currencies[0]?.overall.netPnl).toBe('150');
  });

  it('an open trade in another currency is flagged, and the open risk is unverifiable', () => {
    const db = riskDb();
    openTrade(db, { quoteCurrency: 'EUR', feesCurrency: 'EUR' });
    const d = loadDashboard(db, 1, NOW);
    expect(d.openTrades[0]?.risk.amount).toBeNull();
    expect(d.openTrades[0]?.risk.problem).toContain('EUR');
    expect(d.usage.openRisk.used).toBeNull();
  });

  it('keeps only the most recent closed trades', () => {
    const db = riskDb();
    for (let i = 1; i <= RECENT_CLOSED + 2; i++) {
      closedTrade(db, { pnl: i, closedAt: `2026-02-${String(i).padStart(2, '0')}T10:00:00.000Z` });
    }
    const d = loadDashboard(db, 1, NOW);
    expect(d.recentClosed).toHaveLength(RECENT_CLOSED);
    expect(d.recentClosed[0]?.netPnl).toBe(String(RECENT_CLOSED + 2));
    expect(d.counts.closed).toBe(RECENT_CLOSED + 2);
  });

  it('an unknown account is an error, not an empty dashboard', () => {
    expect(() => loadDashboard(riskDb(), 99, NOW)).toThrow(NotFoundError);
  });

  it('is read only: opening the dashboard records nothing, even when a halt is active', () => {
    const db = riskDb();
    closedTrade(db, { pnl: -400, closedAt: '2026-03-10T10:00:00.000Z' }); // daily-loss halt
    const count = () =>
      (db.$client.prepare('SELECT count(*) c FROM risk_events').get() as { c: number }).c;
    const before = count();
    const d = loadDashboard(db, 1, NOW);
    expect(d.risk.halts.map((h) => h.kind)).toEqual(['daily_loss']);
    expect(d.usage.dailyLoss.reached).toBe(true);
    expect(count()).toBe(before);
  });
});

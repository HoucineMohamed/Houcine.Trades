import { describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import { logTrade } from '@/data/journal';
import { listJournal, loadTradeDetail, parseVerdict } from '@/data/journal-view';
import { createSetup } from '@/data/setups';
import { createTrade } from '@/data/trades';
import type { RiskVerdictRow } from '@/data/schema';
import { issueFreshAuth } from '@/domain/auth/stepup';
import { DEFAULT_QUERY, parseJournalQuery } from '@/domain/trades/table';
import { at, closedTrade, riskDb } from '../helpers/risk';

const NOW = at('2026-03-10T12:00:00.000Z');
const planned = (db: ReturnType<typeof riskDb>, over: Record<string, unknown> = {}) =>
  createTrade(
    db,
    {
      accountId: 1,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      status: 'planned',
      plannedEntry: '100',
      stopLoss: '95',
      size: '1',
      quoteCurrency: 'USDT',
      ...over,
    },
    { now: () => NOW },
  );
const q = (raw: Record<string, string> = {}) => parseJournalQuery(raw);

describe('listJournal', () => {
  it('filters by status, direction, symbol (any case) and setup', () => {
    const db = riskDb();
    const setup = createSetup(db, { name: 'Breakout' });
    planned(db, { symbol: 'ETHUSDT', direction: 'short', stopLoss: '105', setupId: setup.id });
    planned(db);
    closedTrade(db, { pnl: 10, closedAt: '2026-03-01T10:00:00.000Z' });

    expect(listJournal(db, 1, q()).page.total).toBe(3);
    expect(listJournal(db, 1, q({ status: 'planned' })).page.total).toBe(2);
    expect(listJournal(db, 1, q({ direction: 'short' })).page.items.map((r) => r.symbol)).toEqual([
      'ETHUSDT',
    ]);
    expect(listJournal(db, 1, q({ symbol: 'ethusdt' })).page.total).toBe(1);
    expect(listJournal(db, 1, q({ setup: String(setup.id) })).page.items[0]?.setupName).toBe(
      'Breakout',
    );
    expect(listJournal(db, 1, q({ status: 'closed', symbol: 'ETHUSDT' })).page.total).toBe(0);
    expect(listJournal(db, 1, q()).totalAll).toBe(3);
  });

  it('only shows the selected account', () => {
    const db = riskDb();
    createAccount(db, { name: 'Other', baseCurrency: 'USDT', startingBalance: '500' });
    planned(db);
    expect(listJournal(db, 2, q()).page.total).toBe(0);
    expect(listJournal(db, 1, q()).page.total).toBe(1);
  });

  it('carries the engine result for closed trades and sorts by it with exact decimals', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 9, closedAt: '2026-03-01T10:00:00.000Z' });
    closedTrade(db, { pnl: 10, closedAt: '2026-03-02T10:00:00.000Z' });
    closedTrade(db, { pnl: -100, closedAt: '2026-03-03T10:00:00.000Z' });
    planned(db);
    const rows = listJournal(db, 1, q({ sort: 'pnl', dir: 'desc' })).page.items;
    expect(rows.map((r) => r.netPnl)).toEqual(['10', '9', '-100', null]);
    expect(rows[0]?.netR).toBe('0.0010');
  });

  it('paginates by 25', () => {
    const db = riskDb();
    for (let i = 0; i < 30; i++) planned(db);
    expect(listJournal(db, 1, q()).page).toMatchObject({ pages: 2, total: 30 });
    expect(listJournal(db, 1, q({ page: '2' })).page.items).toHaveLength(5);
    expect(listJournal(db, 1, q({ page: '9' })).page.page).toBe(2);
  });

  it('flags override trades and can show only those', () => {
    const db = riskDb();
    planned(db);
    logTrade(
      db,
      {
        accountId: 1,
        symbol: 'BTCUSDT',
        assetClass: 'crypto',
        direction: 'long',
        status: 'planned',
        plannedEntry: '100',
        stopLoss: '95',
        size: '30', // risk 150 = 1.5 % > 1 %: refused, logged by override
        quoteCurrency: 'USDT',
      },
      {
        now: () => NOW,
        override: { confirm: 'OVERRIDE', reason: 'I already took this trade' },
        auth: issueFreshAuth(1, NOW),
      },
    );
    expect(listJournal(db, 1, q()).page.items.filter((r) => r.overridden)).toHaveLength(1);
    expect(listJournal(db, 1, { ...DEFAULT_QUERY, overrideOnly: true }).page.total).toBe(1);
  });
});

describe('loadTradeDetail', () => {
  it('returns the trade, its engine result and its verdict snapshots', () => {
    const db = riskDb();
    const closed = closedTrade(db, { pnl: 250, closedAt: '2026-03-02T10:00:00.000Z' });
    const d = loadTradeDetail(db, closed.id);
    expect(d?.trade.id).toBe(closed.id);
    expect(d?.account.name).toBe('Paper');
    expect(d?.result).toMatchObject({ netPnl: '250', outcome: 'win' });
    expect(d?.flags.overridden).toBe(false);
  });

  it('a logged trade carries the verdict the engine gave', () => {
    const db = riskDb();
    const r = logTrade(
      db,
      {
        accountId: 1,
        symbol: 'BTCUSDT',
        assetClass: 'crypto',
        direction: 'long',
        status: 'planned',
        plannedEntry: '100',
        stopLoss: '95',
        takeProfit: '115',
        size: '20',
        quoteCurrency: 'USDT',
      },
      { now: () => NOW },
    );
    const d = loadTradeDetail(db, r.trade.id);
    expect(d?.verdicts).toHaveLength(1);
    expect(d?.verdicts[0]).toMatchObject({ stage: 'created', approved: true, violations: [] });
    expect(d?.verdicts[0]?.numbers).toMatchObject({ riskAmount: '100' });
  });

  it('an unknown trade is null', () => {
    expect(loadTradeDetail(riskDb(), 99)).toBeNull();
  });
});

describe('parseVerdict', () => {
  const row = (snapshotJson: string): RiskVerdictRow => ({
    id: 1,
    tradeId: 1,
    stage: 'created',
    approved: 0,
    violationCodes: '[]',
    warningCodes: '[]',
    snapshotJson,
    overrideReason: 'because',
    createdAt: '2026-03-10T12:00:00.000Z',
  });
  it('reads violations, warnings and numbers', () => {
    const v = parseVerdict(
      row(
        JSON.stringify({
          violations: [{ code: 'MAX_RISK_PER_TRADE', message: 'too big' }],
          warnings: [{ code: 'NO_TARGET', message: 'no target' }],
          numbers: { riskAmount: '150' },
        }),
      ),
    );
    expect(v).toMatchObject({
      approved: false,
      overrideReason: 'because',
      violations: [{ code: 'MAX_RISK_PER_TRADE', message: 'too big' }],
      warnings: [{ code: 'NO_TARGET', message: 'no target' }],
      numbers: { riskAmount: '150' },
    });
  });
  it('damaged or odd JSON shows as "no details", never a crash', () => {
    for (const bad of ['{not json', 'null', '"text"', '[]', '{"violations":"x","numbers":5}']) {
      const v = parseVerdict(row(bad));
      expect(v.violations).toEqual([]);
      expect(v.numbers).toBeNull();
    }
  });
});

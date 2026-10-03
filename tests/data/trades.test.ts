import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import type { Db } from '@/data/client';
import { NotFoundError } from '@/data/errors';
import { createSetup } from '@/data/setups';
import {
  cancelTrade,
  closeTrade,
  createTrade,
  getTrade,
  listTrades,
  openTrade,
  updateTrade,
} from '@/data/trades';
import { ValidationError } from '@/domain/errors';
import { fixedClock, memoryDb } from '../helpers/db';

const input = (over: Record<string, unknown> = {}) => ({
  accountId: 1,
  symbol: 'BTCUSDT',
  assetClass: 'crypto',
  direction: 'long',
  plannedEntry: '100',
  stopLoss: '95',
  takeProfit: '110',
  size: '0.5',
  quoteCurrency: 'USDT',
  ...over,
});

let db: Db;
beforeEach(() => {
  db = memoryDb();
  createAccount(db, { name: 'Paper', baseCurrency: 'USDT', startingBalance: '1000' });
});

const count = () => (db.$client.prepare('SELECT count(*) c FROM trades').get() as { c: number }).c;

describe('createTrade', () => {
  it('stores a planned trade and returns it with timestamps', () => {
    const t = createTrade(db, input(), { now: fixedClock('2026-10-01T10:00:00Z') });
    expect(t).toMatchObject({
      id: 1,
      accountId: 1,
      setupId: null,
      symbol: 'BTCUSDT',
      status: 'planned',
      stopLoss: '95',
      takeProfit: '110',
      size: '0.5',
      fees: '0',
      feesCurrency: 'USDT',
      entryPrice: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(getTrade(db, 1)).toEqual(t);
  });

  it('stores an already-open trade', () => {
    const t = createTrade(
      db,
      input({ status: 'open', entryPrice: '101', openedAt: '2026-10-01T09:00:00Z' }),
    );
    expect(t).toMatchObject({
      status: 'open',
      entryPrice: '101',
      openedAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it('stores money as exact TEXT (no float rounding, no numeric conversion)', () => {
    createTrade(
      db,
      input({
        plannedEntry: '0.00000200',
        stopLoss: '0.00000199',
        takeProfit: '0.00000250',
        size: '123456789012345678.123456789012345678',
        fees: '0.1',
      }),
    );
    const row = db.$client
      .prepare(
        'SELECT typeof(planned_entry) a, typeof(stop_loss) b, typeof(size) c, planned_entry, stop_loss, size, fees FROM trades',
      )
      .get();
    expect(row).toEqual({
      a: 'text',
      b: 'text',
      c: 'text',
      planned_entry: '0.000002',
      stop_loss: '0.00000199',
      size: '123456789012345678.123456789012345678',
      fees: '0.1',
    });
  });

  it('refuses invalid trades and stores nothing', () => {
    expect(() => createTrade(db, input({ stopLoss: undefined }))).toThrow(/Stop-loss/);
    expect(() => createTrade(db, input({ stopLoss: '105' }))).toThrow(/must be below/);
    expect(() => createTrade(db, input({ size: '0' }))).toThrow(/Size/);
    expect(count()).toBe(0);
  });

  it('refuses an unknown account or setup', () => {
    expect(() => createTrade(db, input({ accountId: 42 }))).toThrow(/Account not found/);
    expect(() => createTrade(db, input({ setupId: 42 }))).toThrow(/Setup not found/);
    expect(count()).toBe(0);
  });

  it('accepts a known setup', () => {
    const s = createSetup(db, { name: 'Breakout' });
    expect(createTrade(db, input({ setupId: s.id })).setupId).toBe(s.id);
  });

  it('refuses trades on a live account while the guard is on (even if one sneaks in)', () => {
    db.$client
      .prepare(
        "INSERT INTO accounts (name, mode, base_currency, starting_balance, created_at) VALUES ('Live','live','USD','1','t')",
      )
      .run();
    expect(() => createTrade(db, input({ accountId: 2 }), { tradingMode: 'paper' })).toThrow(
      /paper mode only/,
    );
    expect(count()).toBe(0);
  });
});

describe('lifecycle in the database', () => {
  it('planned -> open -> closed, updating updatedAt each time', () => {
    createTrade(db, input(), { now: fixedClock('2026-10-01T08:00:00Z') });
    const o = openTrade(
      db,
      1,
      { entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' },
      { now: fixedClock('2026-10-01T09:00:05Z') },
    );
    expect(o).toMatchObject({
      status: 'open',
      entryPrice: '100',
      updatedAt: '2026-10-01T09:00:05.000Z',
      createdAt: '2026-10-01T08:00:00.000Z',
    });
    const c = closeTrade(
      db,
      1,
      { exitPrice: '108', closedAt: '2026-10-01T12:00:00Z' },
      { now: fixedClock('2026-10-01T12:00:05Z') },
    );
    expect(c).toMatchObject({
      status: 'closed',
      exitPrice: '108',
      closedAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:05.000Z',
    });
    expect(getTrade(db, 1)).toEqual(c);
  });

  it('planned -> cancelled', () => {
    createTrade(db, input());
    expect(cancelTrade(db, 1).status).toBe('cancelled');
  });

  it('invalid moves fail and leave the stored trade untouched', () => {
    createTrade(db, input());
    const before = getTrade(db, 1);
    expect(() => closeTrade(db, 1, { exitPrice: '108', closedAt: '2026-10-01T12:00:00Z' })).toThrow(
      /planned trade cannot become closed/,
    );
    openTrade(db, 1, { entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' });
    expect(() => cancelTrade(db, 1)).toThrow(/open trade cannot become cancelled/);
    expect(() => closeTrade(db, 1, { exitPrice: '108', closedAt: '2026-10-01T08:00:00Z' })).toThrow(
      /earlier than opened time/,
    );
    expect(getTrade(db, 1)?.status).toBe('open');
    expect(before?.status).toBe('planned');
  });

  it('closing needs an exit price', () => {
    createTrade(db, input({ status: 'open', entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' }));
    expect(() => closeTrade(db, 1, { closedAt: '2026-10-01T12:00:00Z' })).toThrow(/Exit price/);
    expect(getTrade(db, 1)?.exitPrice).toBeNull();
  });

  it('a closed or cancelled trade cannot move again', () => {
    createTrade(db, input({ status: 'open', entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' }));
    closeTrade(db, 1, { exitPrice: '108', closedAt: '2026-10-01T12:00:00Z' });
    expect(() => closeTrade(db, 1, { exitPrice: '1', closedAt: '2026-10-01T13:00:00Z' })).toThrow(
      /closed trade cannot become closed/,
    );
    createTrade(db, input());
    cancelTrade(db, 2);
    expect(() => openTrade(db, 2, { entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' })).toThrow(
      /cancelled trade cannot become open/,
    );
  });

  it('reports a missing trade', () => {
    expect(() => cancelTrade(db, 99)).toThrow(NotFoundError);
    expect(() => updateTrade(db, 99, {})).toThrow(NotFoundError);
    expect(getTrade(db, 99)).toBeUndefined();
  });
});

describe('updateTrade', () => {
  it('edits a planned trade and re-checks the rules', () => {
    createTrade(db, input());
    expect(updateTrade(db, 1, { stopLoss: '90', planNotes: 'wider stop' })).toMatchObject({
      stopLoss: '90',
      planNotes: 'wider stop',
    });
    expect(() => updateTrade(db, 1, { stopLoss: '120' })).toThrow(ValidationError);
    expect(getTrade(db, 1)?.stopLoss).toBe('90');
  });

  it('locks numbers on closed trades but allows journal fields', () => {
    createTrade(db, input({ status: 'open', entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' }));
    closeTrade(db, 1, { exitPrice: '108', closedAt: '2026-10-01T12:00:00Z' });
    expect(() => updateTrade(db, 1, { stopLoss: '1' })).toThrow(
      /cannot be changed on a closed trade/,
    );
    expect(updateTrade(db, 1, { reviewNotes: 'followed plan', emotion: 'calm' })).toMatchObject({
      reviewNotes: 'followed plan',
      emotion: 'calm',
      exitPrice: '108',
    });
  });

  it('cancelled trades are locked', () => {
    createTrade(db, input());
    cancelTrade(db, 1);
    expect(() => updateTrade(db, 1, { emotion: 'x' })).toThrow(/locked/);
  });
});

describe('listTrades', () => {
  beforeEach(() => {
    createAccount(db, { name: 'Second', baseCurrency: 'USD', startingBalance: '500' });
    createTrade(db, input({ symbol: 'BTCUSDT' }), { now: fixedClock('2026-10-01T08:00:00Z') });
    createTrade(db, input({ symbol: 'ETHUSDT' }), { now: fixedClock('2026-10-01T09:00:00Z') });
    createTrade(db, input({ symbol: 'ETHUSDT', accountId: 2 }), {
      now: fixedClock('2026-10-01T10:00:00Z'),
    });
    openTrade(db, 1, { entryPrice: '100', openedAt: '2026-10-01T11:00:00Z' });
  });

  it('lists newest first', () => {
    expect(listTrades(db).map((t) => t.id)).toEqual([3, 2, 1]);
  });

  it('filters by status', () => {
    expect(listTrades(db, { status: 'open' }).map((t) => t.id)).toEqual([1]);
    expect(listTrades(db, { status: 'planned' }).map((t) => t.id)).toEqual([3, 2]);
    expect(listTrades(db, { status: 'closed' })).toEqual([]);
  });

  it('filters by symbol (case-insensitive, exact)', () => {
    expect(listTrades(db, { symbol: 'ethusdt' }).map((t) => t.id)).toEqual([3, 2]);
    expect(listTrades(db, { symbol: 'ETH' })).toEqual([]);
  });

  it('filters by account and combines filters', () => {
    expect(listTrades(db, { accountId: 2 }).map((t) => t.id)).toEqual([3]);
    expect(
      listTrades(db, { accountId: 1, symbol: 'ETHUSDT', status: 'planned' }).map((t) => t.id),
    ).toEqual([2]);
  });

  it('rejects an invalid filter', () => {
    expect(() => listTrades(db, { status: 'won' as never })).toThrow(/Status must be one of/);
  });
});

describe('database-level safety nets (behind the domain rules)', () => {
  const raw = (cols: string, vals: string) =>
    db.$client.prepare(
      `INSERT INTO trades (account_id, symbol, asset_class, direction, status, planned_entry, size, quote_currency, fees_currency, created_at, updated_at, ${cols}) VALUES (1,'X','crypto','long','planned','1','1','USD','USD','t','t', ${vals})`,
    );

  it('a stop-loss is required: NULL and empty are refused', () => {
    expect(() => raw('stop_loss', 'NULL').run()).toThrow(/NOT NULL/);
    expect(() => raw('stop_loss', "''").run()).toThrow(/CHECK/);
    expect(() => raw('stop_loss', "'0.5'").run()).not.toThrow();
  });

  it('refuses bad enum values and incomplete open/closed rows', () => {
    // `initial` is the initial_stop_loss SQL value; give it so the entry/exit CHECKs are reached.
    const base = (status: string, direction: string, assetClass: string, initial = "'0.5'") =>
      db.$client.prepare(
        `INSERT INTO trades (account_id, symbol, asset_class, direction, status, planned_entry, stop_loss, initial_stop_loss, closed_recorded_at, size, quote_currency, fees_currency, created_at, updated_at) VALUES (1,'X','${assetClass}','${direction}','${status}','1','0.5',${initial},'t','1','USD','USD','t','t')`,
      );
    expect(() => base('planned', 'sideways', 'crypto').run()).toThrow(/CHECK/);
    expect(() => base('won', 'long', 'crypto').run()).toThrow(/CHECK/);
    expect(() => base('planned', 'long', 'nft').run()).toThrow(/CHECK/);
    expect(() => base('open', 'long', 'crypto').run()).toThrow(/CHECK/); // no entry data
    expect(() => base('closed', 'long', 'crypto').run()).toThrow(/CHECK/); // no entry/exit data
  });

  it('refuses to delete an account or setup that trades refer to (journal stays intact)', () => {
    const s = createSetup(db, { name: 'S' });
    createTrade(db, input({ setupId: s.id }));
    expect(() => db.$client.prepare('DELETE FROM accounts WHERE id = 1').run()).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => db.$client.prepare('DELETE FROM setups WHERE id = ?').run(s.id)).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('has the four requested indexes', () => {
    const names = (
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trades'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'trades_account_id_idx',
        'trades_status_idx',
        'trades_symbol_idx',
        'trades_opened_at_idx',
      ]),
    );
  });
});

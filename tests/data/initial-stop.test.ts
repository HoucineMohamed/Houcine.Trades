import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import { createDatabase, type Db } from '@/data/client';
import { closeTrade, createTrade, getTrade, openTrade, updateTrade } from '@/data/trades';
import { memoryDb } from '../helpers/db';

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

const initial = (id: number) =>
  (
    db.$client.prepare('SELECT initial_stop_loss v FROM trades WHERE id = ?').get(id) as {
      v: string | null;
    }
  ).v;

describe('initial stop-loss in the repositories', () => {
  it('planned trades have none; opening freezes the current stop; moving the stop keeps it', () => {
    createTrade(db, input());
    expect(getTrade(db, 1)?.initialStopLoss).toBeNull();
    updateTrade(db, 1, { stopLoss: '96' });
    openTrade(db, 1, { entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' });
    expect(getTrade(db, 1)).toMatchObject({ stopLoss: '96', initialStopLoss: '96' });
    updateTrade(db, 1, { stopLoss: '99' });
    expect(getTrade(db, 1)).toMatchObject({ stopLoss: '99', initialStopLoss: '96' });
    closeTrade(db, 1, { exitPrice: '108', closedAt: '2026-10-01T12:00:00Z' });
    expect(getTrade(db, 1)).toMatchObject({
      stopLoss: '99',
      initialStopLoss: '96',
      status: 'closed',
    });
  });

  it('a trade created open gets it immediately', () => {
    createTrade(db, input({ status: 'open', entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' }));
    expect(initial(1)).toBe('95');
  });
});

describe('database protection (triggers)', () => {
  beforeEach(() => {
    createTrade(db, input({ status: 'open', entryPrice: '100', openedAt: '2026-10-01T09:00:00Z' }));
    createTrade(db, input()); // planned, id 2
  });

  it('refuses to change or erase a frozen initial stop', () => {
    const upd = db.$client.prepare('UPDATE trades SET initial_stop_loss = ? WHERE id = 1');
    expect(() => upd.run('90')).toThrow(/cannot be changed once it is set/);
    // Erasing it on an open trade is stopped by one of the two triggers (either message is fine).
    expect(() => upd.run(null)).toThrow(/initial_stop_loss/);
    expect(() => upd.run('95.0')).toThrow(/cannot be changed/); // even the "same number" in other text
    expect(initial(1)).toBe('95');
  });

  it('allows writing the identical value (normal edits re-save every column)', () => {
    expect(() =>
      db.$client.prepare('UPDATE trades SET initial_stop_loss = ? WHERE id = 1').run('95'),
    ).not.toThrow();
  });

  it('refuses open/closed rows without an initial stop (insert and update)', () => {
    const ins = (initialSql: string) =>
      db.$client.prepare(
        `INSERT INTO trades (account_id, symbol, asset_class, direction, status, planned_entry, stop_loss, initial_stop_loss, size, quote_currency, entry_price, opened_at, fees_currency, created_at, updated_at) VALUES (1,'X','crypto','long','open','100','95',${initialSql},'1','USD','100','t','USD','t','t')`,
      );
    expect(() => ins('NULL').run()).toThrow(/need an initial_stop_loss/);
    expect(() => ins("''").run()).toThrow(/need an initial_stop_loss/);
    expect(() => ins("'95'").run()).not.toThrow();
    // Opening a planned row (id 2) through raw SQL without freezing a stop is refused.
    expect(() =>
      db.$client
        .prepare(
          "UPDATE trades SET status = 'open', entry_price = '100', opened_at = 't' WHERE id = 2",
        )
        .run(),
    ).toThrow(/need an initial_stop_loss/);
  });

  it('a planned trade has none yet, and may receive it once', () => {
    expect(initial(2)).toBeNull();
    db.$client.prepare("UPDATE trades SET initial_stop_loss = '95' WHERE id = 2").run();
    expect(() =>
      db.$client.prepare("UPDATE trades SET initial_stop_loss = '94' WHERE id = 2").run(),
    ).toThrow(/cannot be changed/);
  });

  it('the three triggers exist (a future table rebuild must re-create them)', () => {
    const names = (
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trades_initial_stop%'",
        )
        .all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      'trades_initial_stop_frozen',
      'trades_initial_stop_required_insert',
      'trades_initial_stop_required_update',
    ]);
  });
});

describe('migration backfill', () => {
  const statements = (file: string) =>
    fs.readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint');

  it('copies stop_loss into initial_stop_loss for open and closed trades only', () => {
    const old = createDatabase(':memory:');
    for (const s of statements('0000_init_journal.sql')) old.$client.exec(s); // the schema before this module
    old.$client.exec(
      "INSERT INTO accounts (name, mode, base_currency, starting_balance, created_at) VALUES ('A','paper','USD','1000','t')",
    );
    const insert = old.$client.prepare(
      `INSERT INTO trades (account_id, symbol, asset_class, direction, status, planned_entry, stop_loss, size, quote_currency, entry_price, exit_price, opened_at, closed_at, fees_currency, created_at, updated_at)
       VALUES (1,'X','crypto','long',?,'100',?,'1','USD',?,?,?,?,'USD','t','t')`,
    );
    insert.run('planned', '95', null, null, null, null);
    insert.run('open', '97', '100', null, 't1', null);
    insert.run('closed', '98', '100', '110', 't1', 't2');
    insert.run('cancelled', '90', null, null, null, null);

    for (const s of statements('0001_initial_stop_loss.sql')) old.$client.exec(s);

    const rows = old.$client
      .prepare('SELECT status, stop_loss, initial_stop_loss FROM trades ORDER BY id')
      .all();
    expect(rows).toEqual([
      { status: 'planned', stop_loss: '95', initial_stop_loss: null },
      { status: 'open', stop_loss: '97', initial_stop_loss: '97' },
      { status: 'closed', stop_loss: '98', initial_stop_loss: '98' },
      { status: 'cancelled', stop_loss: '90', initial_stop_loss: null },
    ]);
  });
});

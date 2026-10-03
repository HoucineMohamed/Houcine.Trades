import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAccount, getAccount, listAccounts } from '@/data/accounts';
import { NotFoundError } from '@/data/errors';
import { createSetup, getSetup, listSetups, updateSetup } from '@/data/setups';
import { ValidationError } from '@/domain/errors';
import { fixedClock, memoryDb } from '../helpers/db';

const account = { name: 'Paper main', baseCurrency: 'usd', startingBalance: '10000.00' };

describe('test database safety', () => {
  it('uses memory only: no database file is created', () => {
    memoryDb();
    // (The data/ folder itself may exist because the db:* commands create it; no files may.)
    const dbFiles = (dir: string) =>
      fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => /\.(db|sqlite3?)(-wal|-shm)?$/.test(f))
        : [];
    expect(dbFiles('data')).toEqual([]);
    expect(dbFiles('.')).toEqual([]);
  });
});

describe('accounts', () => {
  it('creates a paper account with normalised values', () => {
    const db = memoryDb();
    const created = createAccount(db, account, { now: fixedClock('2026-10-01T10:00:00Z') });
    expect(created).toEqual({
      id: 1,
      name: 'Paper main',
      mode: 'paper',
      baseCurrency: 'USD',
      startingBalance: '10000',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    expect(getAccount(db, 1)).toEqual(created);
  });

  it('stores the starting balance as TEXT, exactly', () => {
    const db = memoryDb();
    createAccount(db, { ...account, startingBalance: '0.00000001' });
    const row = db.$client
      .prepare('SELECT typeof(starting_balance) t, starting_balance v FROM accounts')
      .get();
    expect(row).toEqual({ t: 'text', v: '0.00000001' });
  });

  it('refuses live accounts while the paper-mode guard is on, and stores nothing', () => {
    const db = memoryDb();
    expect(() => createAccount(db, { ...account, mode: 'live' }, { tradingMode: 'paper' })).toThrow(
      /paper mode only/,
    );
    expect(listAccounts(db)).toEqual([]);
  });

  it('the guard also applies by default (uses the real environment guard)', () => {
    const db = memoryDb();
    expect(() => createAccount(db, { ...account, mode: 'live' })).toThrow(ValidationError);
  });

  it('rejects invalid input', () => {
    const db = memoryDb();
    expect(() => createAccount(db, { ...account, startingBalance: '-5' })).toThrow(
      /Starting balance/,
    );
    expect(() => createAccount(db, { ...account, name: '' })).toThrow(/Account name/);
    expect(listAccounts(db)).toEqual([]);
  });

  it('lists accounts and returns undefined for a missing one', () => {
    const db = memoryDb();
    createAccount(db, account);
    createAccount(db, { ...account, name: 'Second' });
    expect(listAccounts(db).map((a) => a.name)).toEqual(['Second', 'Paper main']);
    expect(getAccount(db, 99)).toBeUndefined();
  });

  it('the database itself refuses an invalid mode (CHECK constraint)', () => {
    const db = memoryDb();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO accounts (name, mode, base_currency, starting_balance, created_at) VALUES ('x','demo','USD','1','t')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('setups', () => {
  it('creates, gets and lists setups (sorted by name)', () => {
    const db = memoryDb();
    createSetup(db, { name: 'Pullback' });
    const b = createSetup(
      db,
      { name: ' Breakout ', description: 'Range break' },
      fixedClock('2026-10-01T10:00:00Z'),
    );
    expect(b).toMatchObject({
      name: 'Breakout',
      description: 'Range break',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    expect(getSetup(db, b.id)).toEqual(b);
    expect(listSetups(db).map((s) => s.name)).toEqual(['Breakout', 'Pullback']);
  });

  it('refuses a duplicate name with a clear message', () => {
    const db = memoryDb();
    createSetup(db, { name: 'Breakout' });
    expect(() => createSetup(db, { name: 'Breakout' })).toThrow(/already exists/);
    expect(listSetups(db)).toHaveLength(1);
  });

  it('updates a setup, refuses renaming into a duplicate, and reports a missing one', () => {
    const db = memoryDb();
    const a = createSetup(db, { name: 'A' });
    createSetup(db, { name: 'B' });
    expect(updateSetup(db, a.id, { name: 'A2', description: 'new' })).toMatchObject({
      name: 'A2',
      description: 'new',
    });
    expect(() => updateSetup(db, a.id, { name: 'B' })).toThrow(/already exists/);
    expect(() => updateSetup(db, 999, { name: 'Z' })).toThrow(NotFoundError);
  });

  it('rejects an empty name', () => {
    expect(() => createSetup(memoryDb(), { name: '   ' })).toThrow(/Setup name/);
  });
});

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import { createDatabase } from '@/data/client';
import { closeTrade, createTrade, getTrade, updateTrade } from '@/data/trades';
import { listRiskEvents } from '@/data/risk-events';
import { closedTrade, riskDb } from '../helpers/risk';

/** Every trigger created by the hand-written parts of the migrations (0001, 0002, 0003). */
export const ALL_TRIGGERS = [
  'ai_reviews_no_delete',
  'ai_reviews_no_update',
  'ai_settings_no_delete',
  'ai_usage_no_delete',
  'ai_usage_no_update',
  'auth_events_no_delete',
  'auth_events_no_update',
  'owner_id_frozen',
  'owner_no_delete',
  'recovery_codes_hash_frozen',
  'recovery_codes_no_delete',
  'recovery_codes_use_final',
  'risk_events_no_delete',
  'risk_events_no_update',
  'risk_verdicts_no_delete',
  'risk_verdicts_no_update',
  'sessions_identity_frozen',
  'sessions_no_delete',
  'sessions_revocation_final',
  'trades_closed_recorded_frozen',
  'trades_closed_recorded_required_insert',
  'trades_closed_recorded_required_update',
  'trades_initial_stop_frozen',
  'trades_initial_stop_required_insert',
  'trades_initial_stop_required_update',
].sort();

describe('every account is born with default risk settings', () => {
  it('creates the settings row and logs it', () => {
    const db = riskDb();
    const row = db.$client
      .prepare('SELECT settings_json, pending_json FROM risk_settings WHERE account_id = 1')
      .get() as { settings_json: string; pending_json: string };
    expect(JSON.parse(row.settings_json)).toEqual({
      maxRiskPerTradePercent: '1',
      maxDailyLossPercent: '3',
      maxOpenRiskPercent: '3',
      maxOpenTrades: 3,
      maxDrawdownPercent: '10',
      minRewardToRisk: '1.5',
    });
    expect(row.pending_json).toBe('{}');
    expect(listRiskEvents(db, 1).map((e) => e.kind)).toEqual(['settings_change']);
  });

  it('a second account gets its own settings', () => {
    const db = riskDb();
    createAccount(db, { name: 'Second', baseCurrency: 'USD', startingBalance: '1' });
    expect(
      (db.$client.prepare('SELECT count(*) c FROM risk_settings').get() as { c: number }).c,
    ).toBe(2);
  });
});

describe('recorded-as-closed time', () => {
  it('is set when a trade is closed, to the moment of the closing write', () => {
    const db = riskDb();
    const t = closedTrade(db, {
      pnl: -100,
      closedAt: '2026-03-09T12:00:00.000Z',
      recordedAt: '2026-03-10T14:00:00.000Z',
    });
    expect(t.closedAt).toBe('2026-03-09T12:00:00.000Z');
    expect(t.closedRecordedAt).toBe('2026-03-10T14:00:00.000Z');
  });

  it('does not move when review notes are edited later (updated_at moves, it does not)', () => {
    const db = riskDb();
    const t = closedTrade(db, { pnl: -100, closedAt: '2026-03-09T12:00:00.000Z' });
    const edited = updateTrade(
      db,
      t.id,
      { reviewNotes: 'later thoughts' },
      { now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(edited.updatedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(edited.closedRecordedAt).toBe('2026-03-09T12:00:00.000Z');
  });

  it('the database refuses to change it, to erase it, or to close a trade without it', () => {
    const db = riskDb();
    const t = closedTrade(db, { pnl: 5, closedAt: '2026-03-09T12:00:00.000Z' });
    const upd = db.$client.prepare('UPDATE trades SET closed_recorded_at = ? WHERE id = ?');
    expect(() => upd.run('2030-01-01T00:00:00.000Z', t.id)).toThrow(
      /cannot be changed once it is set/,
    );
    expect(() => upd.run(null, t.id)).toThrow(/closed_recorded_at/);
    expect(getTrade(db, t.id)?.closedRecordedAt).toBe('2026-03-09T12:00:00.000Z');

    // a trade cannot become closed without it, whatever the SQL
    const open = createTrade(db, {
      accountId: 1,
      symbol: 'X',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100',
      stopLoss: '90',
      size: '1',
      quoteCurrency: 'USDT',
      entryPrice: '100',
      openedAt: '2026-01-01T00:00:00Z',
    });
    expect(() =>
      db.$client
        .prepare(
          "UPDATE trades SET status = 'closed', exit_price = '110', closed_at = '2026-02-01T00:00:00.000Z' WHERE id = ?",
        )
        .run(open.id),
    ).toThrow(/need a closed_recorded_at/);
  });

  it('every trigger from the migrations exists (a future table rebuild must re-create them all)', () => {
    const db = riskDb();
    const names = (
      db.$client.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(ALL_TRIGGERS);
  });
});

describe('append-only logs', () => {
  it('risk_events rows can be added but never changed or deleted', () => {
    const db = riskDb();
    expect(() => db.$client.prepare("UPDATE risk_events SET reason = 'edited'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.$client.prepare('DELETE FROM risk_events').run()).toThrow(/append-only/);
    expect(listRiskEvents(db, 1)).toHaveLength(1);
  });

  it('risk_verdicts rows can be added but never changed or deleted; refused needs a reason', () => {
    const db = riskDb();
    const t = closedTrade(db, { pnl: 1, closedAt: '2026-03-09T12:00:00.000Z' });
    const insert = (approved: number, reason: string | null) =>
      db.$client
        .prepare(
          "INSERT INTO risk_verdicts (trade_id, stage, approved, violation_codes, warning_codes, snapshot_json, override_reason, created_at) VALUES (?, 'created', ?, '[]', '[]', '{}', ?, 't')",
        )
        .run(t.id, approved, reason);
    expect(() => insert(0, null)).toThrow(/CHECK/); // refused without an override reason
    expect(() => insert(0, '')).toThrow(/CHECK/);
    expect(() => insert(2, null)).toThrow(/CHECK/);
    expect(() => insert(1, null)).not.toThrow();
    expect(() => insert(0, 'logged what I already did')).not.toThrow();
    expect(() => db.$client.prepare('UPDATE risk_verdicts SET approved = 1').run()).toThrow(
      /append-only/,
    );
    expect(() => db.$client.prepare('DELETE FROM risk_verdicts').run()).toThrow(/append-only/);
  });

  it('events and verdicts keep a trade or account from being deleted', () => {
    const db = riskDb();
    expect(() => db.$client.prepare('DELETE FROM risk_settings').run()).not.toThrow(); // settings may be replaced
    expect(() => db.$client.prepare('DELETE FROM accounts WHERE id = 1').run()).toThrow(
      /FOREIGN KEY/,
    ); // events point at it
  });
});

describe('migration 0002 backfill', () => {
  const statements = (file: string) =>
    fs.readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint');

  it('gives existing accounts default settings and closed trades a recorded time', () => {
    const old = createDatabase(':memory:');
    for (const f of ['0000_init_journal.sql', '0001_initial_stop_loss.sql'])
      for (const s of statements(f)) old.$client.exec(s);
    old.$client.exec(
      "INSERT INTO accounts (name, mode, base_currency, starting_balance, created_at) VALUES ('Old','paper','USD','500','c')",
    );
    const insert = old.$client.prepare(
      `INSERT INTO trades (account_id, symbol, asset_class, direction, status, planned_entry, stop_loss, initial_stop_loss, size, quote_currency, entry_price, exit_price, opened_at, closed_at, fees_currency, created_at, updated_at)
       VALUES (1,'X','crypto','long',?,'100','95',?,'1','USD',?,?,?,?,'USD','c','2026-02-02T00:00:00.000Z')`,
    );
    insert.run('planned', null, null, null, null, null);
    insert.run('closed', '95', '100', '110', 'o', 'c');

    for (const s of statements('0002_risk_engine.sql')) old.$client.exec(s);

    expect(
      old.$client
        .prepare('SELECT account_id, settings_json, pending_json FROM risk_settings')
        .all(),
    ).toEqual([
      {
        account_id: 1,
        settings_json:
          '{"maxRiskPerTradePercent":"1","maxDailyLossPercent":"3","maxOpenRiskPercent":"3","maxOpenTrades":3,"maxDrawdownPercent":"10","minRewardToRisk":"1.5"}',
        pending_json: '{}',
      },
    ]);
    expect(
      old.$client.prepare('SELECT status, closed_recorded_at FROM trades ORDER BY id').all(),
    ).toEqual([
      { status: 'planned', closed_recorded_at: null },
      { status: 'closed', closed_recorded_at: '2026-02-02T00:00:00.000Z' },
    ]);
  });
});

describe('the closing write cannot be bypassed by the repository either', () => {
  it('closeTrade without a clock still records a real time', () => {
    const db = riskDb();
    const trade = createTrade(db, {
      accountId: 1,
      symbol: 'X',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100',
      stopLoss: '90',
      size: '1',
      quoteCurrency: 'USDT',
      entryPrice: '100',
      openedAt: '2026-01-01T00:00:00Z',
    });
    const closed = closeTrade(db, trade.id, { exitPrice: '110', closedAt: '2026-02-01T00:00:00Z' });
    expect(Number.isNaN(new Date(closed.closedRecordedAt as string).getTime())).toBe(false);
  });
});

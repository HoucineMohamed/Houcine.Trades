import { describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import { NotFoundError } from '@/data/errors';
import {
  evaluatePlanForAccount,
  getRiskSettingsView,
  haltManually,
  loadRiskContext,
  resetHalt,
  restoreDefaultRiskSettings,
  syncRiskState,
  updateRiskSettings,
} from '@/data/risk';
import { listRiskEvents } from '@/data/risk-events';
import { issueFreshAuth } from '@/domain/auth/stepup';
import { ValidationError } from '@/domain/errors';
import { at, closedTrade, restartDb, riskDb } from '../helpers/risk';

/** A genuine step-up proof verified at `now`. */
const fresh = (now: Date) => issueFreshAuth(1, now);

const plan = (over: Record<string, string | null> = {}) => ({
  symbol: 'BTCUSDT',
  direction: 'long',
  entry: '100',
  stop: '95',
  target: '115',
  size: '20',
  quoteCurrency: 'USDT',
  ...over,
});
const kinds = (db: ReturnType<typeof riskDb>, now: Date) =>
  loadRiskContext(db, 1, now)
    .halts.map((h) => h.kind)
    .sort();
const eventKinds = (db: ReturnType<typeof riskDb>) =>
  listRiskEvents(db, 1, 100)
    .map((e) => `${e.kind}${e.haltKind ? ':' + e.haltKind : ''}`)
    .reverse();

describe('context from real data', () => {
  it('equity, open trades and the day figures come from the journal', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 500, closedAt: '2026-03-09T10:00:00.000Z' });
    closedTrade(db, { pnl: -100, closedAt: '2026-03-10T10:00:00.000Z' });
    const c = loadRiskContext(db, 1, at('2026-03-10T15:00:00.000Z'));
    expect(c).toMatchObject({
      equity: '10400',
      dayStartEquity: '10500',
      todayNetPnl: '-100',
      baseCurrency: 'USDT',
      accountKnown: true,
    });
  });

  it('an unknown account fails closed', () => {
    const db = riskDb();
    const { verdict } = evaluatePlanForAccount(db, 99, plan());
    expect(verdict.approved).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('ACCOUNT_UNKNOWN');
  });

  it('a plan in another currency than the account is refused (no conversion)', () => {
    const db = riskDb();
    const { verdict } = evaluatePlanForAccount(db, 1, plan({ quoteCurrency: 'EUR' }));
    expect(verdict.violations.map((v) => v.code)).toEqual(['CURRENCY_MISMATCH']);
  });

  it('a normal plan is approved on a fresh account', () => {
    const db = riskDb();
    expect(evaluatePlanForAccount(db, 1, plan()).verdict.approved).toBe(true);
  });
});

describe('a backdated loss counts toward today (closed time OR recorded time)', () => {
  const NOW = at('2026-03-10T15:00:00.000Z');

  it('closed "yesterday" but entered today: counts today and halts trading', () => {
    const db = riskDb();
    closedTrade(db, {
      pnl: -400,
      closedAt: '2026-03-09T12:00:00.000Z',
      recordedAt: '2026-03-10T14:00:00.000Z',
    });
    const c = loadRiskContext(db, 1, NOW);
    expect(c.todayNetPnl).toBe('-400');
    expect(c.halts.map((h) => h.kind)).toEqual(['daily_loss']);
    expect(
      // (a smaller plan: equity is now 9600, and 1 % of it is 96)
      evaluatePlanForAccount(db, 1, plan({ size: '15' }), NOW).verdict.violations.map(
        (v) => v.code,
      ),
    ).toEqual(['HALTED_DAILY_LOSS']);
  });

  it('control: entered yesterday as well: not today', () => {
    const db = riskDb();
    closedTrade(db, { pnl: -400, closedAt: '2026-03-09T12:00:00.000Z' });
    expect(kinds(db, NOW)).toEqual([]);
  });

  it('editing the notes of an old loss today does NOT make it count today', () => {
    const db = riskDb();
    const t = closedTrade(db, { pnl: -400, closedAt: '2026-03-09T12:00:00.000Z' });
    // (the notes are edited today; updated_at moves, closed_recorded_at must not)
    db.$client
      .prepare(
        "UPDATE trades SET review_notes = 'later', updated_at = '2026-03-10T14:00:00.000Z' WHERE id = ?",
      )
      .run(t.id);
    expect(loadRiskContext(db, 1, NOW).todayNetPnl).toBe('0');
    expect(kinds(db, NOW)).toEqual([]);
  });
});

describe('daily-loss halt over the days', () => {
  it('halts at the limit and clears at the next UTC midnight, by itself', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 500, closedAt: '2026-03-09T10:00:00.000Z' });
    closedTrade(db, { pnl: -315, closedAt: '2026-03-10T10:00:00.000Z' });
    expect(kinds(db, at('2026-03-10T23:59:59.999Z'))).toEqual(['daily_loss']);
    expect(kinds(db, at('2026-03-11T00:00:00.000Z'))).toEqual([]);
  });

  it('is logged once per day by the sync, and sync is idempotent', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 500, closedAt: '2026-03-09T10:00:00.000Z' });
    closedTrade(db, { pnl: -315, closedAt: '2026-03-10T10:00:00.000Z' });
    syncRiskState(db, 1, at('2026-03-10T15:00:00.000Z'));
    syncRiskState(db, 1, at('2026-03-10T16:00:00.000Z'));
    expect(eventKinds(db).filter((k) => k === 'halt:daily_loss')).toHaveLength(1);
  });
});

describe('manual halt (the kill switch)', () => {
  const NOW = at('2026-03-10T15:00:00.000Z');

  it('halts every plan at once and survives a restart', () => {
    const db = riskDb();
    haltManually(db, 1, 'I am tired today', NOW);
    expect(
      evaluatePlanForAccount(db, 1, plan(), NOW).verdict.violations.map((v) => v.code),
    ).toEqual(['HALTED_MANUAL']);
    const restarted = restartDb(db);
    expect(kinds(restarted, at('2026-06-01T00:00:00.000Z'))).toEqual(['manual']); // months later, after a restart
    expect(evaluatePlanForAccount(restarted, 1, plan(), NOW).verdict.approved).toBe(false);
  });

  it('can be reset at once, but only with the typed word RESET and a reason', () => {
    const db = riskDb();
    haltManually(db, 1, 'cooling off', NOW);
    const before = eventKinds(db).length;
    expect(() =>
      resetHalt(
        db,
        1,
        'manual',
        { confirm: 'reset', reason: 'rested and reviewed my plan' },
        fresh(NOW),
        NOW,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      resetHalt(db, 1, 'manual', { confirm: 'RESET', reason: 'short' }, fresh(NOW), NOW),
    ).toThrow(/at least 10/);
    expect(eventKinds(db)).toHaveLength(before); // mistakes in typing are not events
    resetHalt(
      db,
      1,
      'manual',
      { confirm: 'RESET', reason: 'rested and reviewed my plan' },
      fresh(NOW),
      NOW,
    );
    expect(kinds(db, NOW)).toEqual([]);
    expect(evaluatePlanForAccount(db, 1, plan(), NOW).verdict.approved).toBe(true);
    const reset = listRiskEvents(db, 1, 1)[0]!;
    expect(reset).toMatchObject({
      kind: 'reset',
      haltKind: 'manual',
      reason: 'rested and reviewed my plan',
    });
  });

  it('refuses a second halt, a reset of nothing, and an empty reason', () => {
    const db = riskDb();
    expect(() =>
      resetHalt(
        db,
        1,
        'manual',
        { confirm: 'RESET', reason: 'nothing is halted here' },
        fresh(NOW),
        NOW,
      ),
    ).toThrow(/no active manual halt/);
    expect(() => haltManually(db, 1, 'ab', NOW)).toThrow(ValidationError);
    haltManually(db, 1, 'first', NOW);
    expect(() => haltManually(db, 1, 'second', NOW)).toThrow(/already halted/);
    expect(() => haltManually(db, 99, 'unknown', NOW)).toThrow(NotFoundError);
  });
});

describe('drawdown halt: reset only 24 hours after it began', () => {
  // start 10000 -> +2000 (peak 12000) -> -1200 on 2 March 09:00 UTC = exactly 10 % -> halt begins
  function breached() {
    const db = riskDb();
    closedTrade(db, { pnl: 2000, closedAt: '2026-03-01T10:00:00.000Z' });
    closedTrade(db, { pnl: -1200, closedAt: '2026-03-02T09:00:00.000Z' });
    // synced on the NEXT day: the loss was on 2 March so it is not "today" any more and only the
    // drawdown halt is active (on the day itself the daily-loss halt would ALSO be active)
    syncRiskState(db, 1, at('2026-03-03T00:00:00.000Z')); // latches the halt
    return db;
  }
  const RESET = { confirm: 'RESET', reason: 'reviewed my trades and my plan' };

  it('latches the halt in the event log with the begin time', () => {
    const db = breached();
    const halt = listRiskEvents(db, 1, 1)[0]!;
    expect(halt).toMatchObject({ kind: 'halt', haltKind: 'drawdown' });
    expect(JSON.parse(halt.detailsJson).beganAt).toBe('2026-03-02T09:00:00.000Z');
  });

  it('before 24 hours: refused with the time remaining, and the attempt is logged', () => {
    const db = breached();
    const early = at('2026-03-03T08:59:59.999Z');
    expect(() => resetHalt(db, 1, 'drawdown', RESET, fresh(early), early)).toThrow(
      /24 hours.*0h 00m 01s/,
    );
    expect(kinds(db, early)).toEqual(['drawdown']); // still halted
    const last = listRiskEvents(db, 1, 1)[0]!;
    expect(last).toMatchObject({
      kind: 'reset_refused',
      haltKind: 'drawdown',
      reason: RESET.reason,
    });
    expect(JSON.parse(last.detailsJson)).toMatchObject({
      remainingMs: 1,
      availableAt: '2026-03-03T09:00:00.000Z',
    });
  });

  it('exactly at 24 hours: allowed, and the new baseline is the equity at that moment', () => {
    const db = breached();
    const exactly = at('2026-03-03T09:00:00.000Z');
    resetHalt(db, 1, 'drawdown', RESET, fresh(exactly), exactly);
    const reset = listRiskEvents(db, 1, 1)[0]!;
    expect(reset).toMatchObject({ kind: 'reset', haltKind: 'drawdown' });
    expect(JSON.parse(reset.detailsJson)).toMatchObject({
      baselineEquity: '10800',
      previousPeakEquity: '12000',
      haltBeganAt: '2026-03-02T09:00:00.000Z',
    });
    const c = loadRiskContext(db, 1, at('2026-03-03T09:00:00.001Z'));
    expect(c.halts).toEqual([]);
    expect(c.baselineEquity).toBe('10800');
    expect(
      evaluatePlanForAccount(db, 1, plan(), at('2026-03-03T09:00:00.001Z')).verdict.approved,
    ).toBe(true);
  });

  it('after 24 hours: allowed', () => {
    const db = breached();
    resetHalt(
      db,
      1,
      'drawdown',
      RESET,
      fresh(at('2026-03-20T00:00:00.000Z')),
      at('2026-03-20T00:00:00.000Z'),
    );
    expect(kinds(db, at('2026-03-20T00:00:01.000Z'))).toEqual([]);
  });

  it('the halt survives a restart, and so does the refusal', () => {
    const db = breached();
    const restarted = restartDb(db);
    expect(kinds(restarted, at('2026-03-03T01:00:00.000Z'))).toEqual(['drawdown']);
    expect(() =>
      resetHalt(
        restarted,
        1,
        'drawdown',
        RESET,
        fresh(at('2026-03-03T01:00:00.000Z')),
        at('2026-03-03T01:00:00.000Z'),
      ),
    ).toThrow(/24 hours/);
  });

  it('a wrong typed confirmation is an input error and is not logged as a refusal', () => {
    const db = breached();
    const n = eventKinds(db).length;
    expect(() =>
      resetHalt(
        db,
        1,
        'drawdown',
        { confirm: 'yes', reason: 'reviewed my trades' },
        fresh(at('2026-03-20T00:00:00.000Z')),
        at('2026-03-20T00:00:00.000Z'),
      ),
    ).toThrow(ValidationError);
    expect(eventKinds(db)).toHaveLength(n);
  });

  it('a daily-loss halt cannot be reset at all', () => {
    const db = riskDb();
    closedTrade(db, { pnl: -400, closedAt: '2026-03-10T10:00:00.000Z' });
    expect(() =>
      resetHalt(
        db,
        1,
        'drawdown',
        RESET,
        fresh(at('2026-03-10T15:00:00.000Z')),
        at('2026-03-10T15:00:00.000Z'),
      ),
    ).toThrow(/no active drawdown halt/);
    expect(kinds(db, at('2026-03-10T15:00:00.000Z'))).toEqual(['daily_loss']);
  });

  it('recovering equity does not lift the halt; only the reset does, and a new fall halts again', () => {
    const db = breached();
    closedTrade(db, { pnl: 1000, closedAt: '2026-03-02T10:00:00.000Z' }); // equity back to 11800
    expect(kinds(db, at('2026-03-02T12:00:00.000Z'))).toEqual(['drawdown']);
    resetHalt(
      db,
      1,
      'drawdown',
      RESET,
      fresh(at('2026-03-03T10:00:00.000Z')),
      at('2026-03-03T10:00:00.000Z'),
    ); // baseline 11800
    closedTrade(db, { pnl: -1180, closedAt: '2026-03-05T10:00:00.000Z' }); // exactly 10 % of 11800
    expect(kinds(db, at('2026-03-07T00:00:00.000Z'))).toEqual(['drawdown']);
  });
});

describe('settings: ceilings, tightening now, loosening after 24 hours', () => {
  const NOW = at('2026-03-10T12:00:00.000Z');

  it('rejects anything above a hard ceiling and saves nothing', () => {
    const db = riskDb();
    expect(() =>
      updateRiskSettings(db, 1, { maxRiskPerTradePercent: '3', maxOpenTrades: 9 }, fresh(NOW), NOW),
    ).toThrow(ValidationError);
    expect(getRiskSettingsView(db, 1, NOW).active?.maxRiskPerTradePercent).toBe('1');
    expect(eventKinds(db)).toEqual(['settings_change']); // only the creation event
  });

  it('tightening takes effect immediately and changes the verdict at once', () => {
    const db = riskDb();
    // plan risk = 100 = 1 % of 10000: fine now
    expect(evaluatePlanForAccount(db, 1, plan(), NOW).verdict.approved).toBe(true);
    const r = updateRiskSettings(db, 1, { maxRiskPerTradePercent: '0.5' }, fresh(NOW), NOW);
    expect(r.applied).toHaveLength(1);
    const v = evaluatePlanForAccount(db, 1, plan(), NOW).verdict;
    expect(v.violations.map((x) => x.code)).toEqual(['MAX_RISK_PER_TRADE']);
  });

  it('loosening waits 24 hours: refused at +23h59m59.999s, allowed exactly at +24h', () => {
    const db = riskDb();
    const bigger = plan({ size: '30' }); // risk 150 = 1.5 %
    expect(
      evaluatePlanForAccount(db, 1, bigger, NOW).verdict.violations.map((v) => v.code),
    ).toEqual(['MAX_RISK_PER_TRADE']);
    const r = updateRiskSettings(db, 1, { maxRiskPerTradePercent: '1.5' }, fresh(NOW), NOW);
    expect(r.deferred[0]).toMatchObject({
      field: 'maxRiskPerTradePercent',
      effectiveAt: '2026-03-11T12:00:00.000Z',
    });
    // the visible view says pending
    const view = getRiskSettingsView(db, 1, NOW);
    expect(view.active?.maxRiskPerTradePercent).toBe('1');
    expect(view.pending.maxRiskPerTradePercent?.value).toBe('1.5');

    const early = at('2026-03-11T11:59:59.999Z');
    expect(evaluatePlanForAccount(db, 1, bigger, early).verdict.approved).toBe(false);
    const exactly = at('2026-03-11T12:00:00.000Z');
    expect(evaluatePlanForAccount(db, 1, bigger, exactly).verdict.approved).toBe(true);
    expect(getRiskSettingsView(db, 1, exactly).effective?.maxRiskPerTradePercent).toBe('1.5');
  });

  it('the sync saves a loosened setting once it is due, and logs it', () => {
    const db = riskDb();
    updateRiskSettings(db, 1, { maxOpenTrades: 4 }, fresh(NOW), NOW);
    syncRiskState(db, 1, at('2026-03-11T12:00:00.000Z'));
    const view = getRiskSettingsView(db, 1, at('2026-03-11T12:00:00.000Z'));
    expect(view.active?.maxOpenTrades).toBe(4);
    expect(view.pending).toEqual({});
    expect(eventKinds(db)).toEqual(['settings_change', 'settings_change', 'settings_applied']);
  });

  it('every change is logged with what was applied, deferred and cancelled', () => {
    const db = riskDb();
    updateRiskSettings(
      db,
      1,
      { maxRiskPerTradePercent: '0.5', maxDailyLossPercent: '4' },
      fresh(NOW),
      NOW,
    );
    const e = listRiskEvents(db, 1, 1)[0]!;
    const d = JSON.parse(e.detailsJson);
    expect(d.applied).toHaveLength(1);
    expect(d.deferred).toHaveLength(1);
  });

  it('a pending loosening can not hide a drawdown that already happened', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 2000, closedAt: '2026-03-01T10:00:00.000Z' });
    closedTrade(db, { pnl: -1200, closedAt: '2026-03-02T09:00:00.000Z' });
    // nobody has looked yet (no latch). The user asks to loosen the drawdown limit...
    updateRiskSettings(
      db,
      1,
      { maxDrawdownPercent: '15' },
      fresh(at('2026-03-02T09:30:00.000Z')),
      at('2026-03-02T09:30:00.000Z'),
    ); // (this call latches first)
    // ...and a day later the looser limit is in force, but the halt stands
    const later = at('2026-03-04T00:00:00.000Z');
    expect(getRiskSettingsView(db, 1, later).effective?.maxDrawdownPercent).toBe('15');
    expect(kinds(db, later)).toEqual(['drawdown']);
    expect(eventKinds(db)).toContain('halt:drawdown');
  });
});

describe('corrupt settings fail closed, and can be repaired', () => {
  const NOW = at('2026-03-10T12:00:00.000Z');

  it('refuses every plan while the stored settings are unreadable or above a ceiling', () => {
    const db = riskDb();
    db.$client.prepare("UPDATE risk_settings SET settings_json = '{not json'").run();
    let v = evaluatePlanForAccount(db, 1, plan(), NOW).verdict;
    expect(v.violations.map((x) => x.code)).toEqual(['SETTINGS_INVALID']);

    db.$client.prepare('UPDATE risk_settings SET settings_json = ?').run(
      JSON.stringify({
        maxRiskPerTradePercent: '50',
        maxDailyLossPercent: '3',
        maxOpenRiskPercent: '3',
        maxOpenTrades: 3,
        maxDrawdownPercent: '10',
        minRewardToRisk: '1.5',
      }),
    );
    v = evaluatePlanForAccount(db, 1, plan(), NOW).verdict;
    expect(v.violations.map((x) => x.code)).toEqual(['SETTINGS_INVALID']);

    db.$client.prepare('DELETE FROM risk_settings').run();
    expect(evaluatePlanForAccount(db, 1, plan(), NOW).verdict.approved).toBe(false);
  });

  it('a settings change is refused while corrupt; restoring the defaults needs RESET and a reason', () => {
    const db = riskDb();
    db.$client.prepare("UPDATE risk_settings SET settings_json = 'garbage'").run();
    expect(() => updateRiskSettings(db, 1, { maxOpenTrades: 2 }, fresh(NOW), NOW)).toThrow(
      /corrupt/,
    );
    expect(() =>
      restoreDefaultRiskSettings(db, 1, { confirm: 'no', reason: 'x' }, fresh(NOW), NOW),
    ).toThrow(ValidationError);
    restoreDefaultRiskSettings(
      db,
      1,
      { confirm: 'RESET', reason: 'the stored settings were damaged' },
      fresh(NOW),
      NOW,
    );
    expect(evaluatePlanForAccount(db, 1, plan(), NOW).verdict.approved).toBe(true);
    expect(listRiskEvents(db, 1, 1)[0]).toMatchObject({
      kind: 'settings_change',
      reason: 'the stored settings were damaged',
    });
  });

  it('corrupt pending changes also fail closed', () => {
    const db = riskDb();
    db.$client.prepare("UPDATE risk_settings SET pending_json = '[1,2'").run();
    expect(
      evaluatePlanForAccount(db, 1, plan(), NOW).verdict.violations.map((v) => v.code),
    ).toEqual(['SETTINGS_INVALID']);
  });
});

describe('an account with a trade in another currency still works for its own currency', () => {
  it('open trades in another currency make open risk unverifiable (refused), but equity is unaffected', () => {
    const db = riskDb();
    createAccount(db, { name: 'Other', baseCurrency: 'EUR', startingBalance: '1000' });
    expect(loadRiskContext(db, 2, at('2026-03-10T12:00:00.000Z')).equity).toBe('1000');
  });
});

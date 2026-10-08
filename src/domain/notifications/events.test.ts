import { describe, expect, it } from 'vitest';
import {
  eventFromAnalystUsage,
  eventFromAuthEvent,
  eventFromRiskEvent,
  eventFromVerdict,
  FILTER_EXEMPT_KINDS,
  haltClearedEvents,
  KIND_CATEGORY,
  loginBurstEvents,
  makeEvent,
  severityOf,
} from './events';
import { EVENT_KINDS, RESERVED_KINDS, USAGE_KINDS } from './kinds';

describe('every event kind has a category and a severity', () => {
  it('covers all kinds', () => {
    for (const k of EVENT_KINDS) {
      expect(KIND_CATEGORY[k], k).toBeDefined();
      expect(['info', 'warning', 'critical']).toContain(severityOf(k, 80));
    }
  });
  it('usage events: 50 info, 80 warning, 100 critical (analyst caps stay warning)', () => {
    for (const k of USAGE_KINDS) {
      const analyst = k.startsWith('analyst_');
      expect(severityOf(k, 50)).toBe('info');
      expect(severityOf(k, 80)).toBe('warning');
      expect(severityOf(k, 100)).toBe(analyst ? 'warning' : 'critical');
    }
  });
  it('fixed severities of the important kinds', () => {
    expect(severityOf('halt_started_daily_loss', null)).toBe('critical');
    expect(severityOf('halt_started_drawdown', null)).toBe('critical');
    expect(severityOf('halt_started_manual', null)).toBe('warning');
    expect(severityOf('recovery_code_used', null)).toBe('critical');
    expect(severityOf('notifications_switched_off', null)).toBe('critical');
    expect(severityOf('login_success', null)).toBe('info');
    expect(severityOf('halt_cleared', null)).toBe('info');
    expect(severityOf('analyst_call_failed', null)).toBe('info');
  });
  it('categories', () => {
    expect(KIND_CATEGORY.daily_loss_usage).toBe('risk');
    expect(KIND_CATEGORY.login_success).toBe('security');
    expect(KIND_CATEGORY.analyst_call_failed).toBe('analyst');
    expect(KIND_CATEGORY.notifications_switched_off).toBe('system');
  });
  it('the reserved system kinds exist (backup, market data) and nothing maps to them', () => {
    expect(RESERVED_KINDS).toEqual(['backup_failed', 'market_data_stale']);
    const rows = ['halt', 'reset', 'reset_refused', 'plan_refused', 'override', 'settings_change'];
    for (const kind of rows) {
      const e = eventFromRiskEvent({
        id: 1,
        accountId: 1,
        kind,
        haltKind: 'manual',
        createdAt: 't',
      });
      expect(e && RESERVED_KINDS.includes(e.kind)).toBeFalsy();
    }
  });
  it('the exempt kinds are only about the alerts themselves', () => {
    expect([...FILTER_EXEMPT_KINDS].sort()).toEqual([
      'flood_summary',
      'notifications_switched_off',
      'test_message',
    ]);
  });
});

describe('risk records', () => {
  const row = (kind: string, haltKind: string | null = null) => ({
    id: 7,
    accountId: 2,
    kind,
    haltKind,
    createdAt: '2026-03-10T10:00:00.000Z',
  });
  it.each([
    ['daily_loss', 'halt_started_daily_loss', 'critical'],
    ['drawdown', 'halt_started_drawdown', 'critical'],
    ['manual', 'halt_started_manual', 'warning'],
  ])('a %s halt row', (haltKind, kind, severity) => {
    expect(eventFromRiskEvent(row('halt', haltKind))).toMatchObject({
      kind,
      severity,
      category: 'risk',
      dedupeKey: 'risk_event:7',
      accountId: 2,
      occurredAt: '2026-03-10T10:00:00.000Z',
    });
  });
  it('an unknown halt kind gives nothing (never guessed)', () => {
    expect(eventFromRiskEvent(row('halt', 'weird'))).toBeNull();
    expect(eventFromRiskEvent(row('halt', null))).toBeNull();
  });
  it('a refused drawdown reset and an override', () => {
    expect(eventFromRiskEvent(row('reset_refused'))).toMatchObject({
      kind: 'drawdown_reset_refused',
      severity: 'warning',
    });
    expect(eventFromRiskEvent(row('override'))).toMatchObject({
      kind: 'override_logged',
      severity: 'warning',
    });
  });
  it('other rows (plan_refused, settings, reset) give nothing: a cleared halt comes from a state change', () => {
    for (const k of ['plan_refused', 'settings_change', 'settings_applied', 'reset']) {
      expect(eventFromRiskEvent(row(k))).toBeNull();
    }
  });
  it('a rule-violating trade is a verdict that was not approved', () => {
    const v = { id: 5, accountId: 1, createdAt: 't' };
    expect(eventFromVerdict({ ...v, approved: 0 })).toMatchObject({
      kind: 'rule_violation_trade_logged',
      dedupeKey: 'verdict:5',
    });
    expect(eventFromVerdict({ ...v, approved: 1 })).toBeNull();
  });
  it('a halt that is gone is a cleared halt (one event per kind that ended)', () => {
    const at = new Date('2026-03-11T00:00:00.000Z');
    const e = haltClearedEvents(2, ['daily_loss', 'manual'], ['manual'], at);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'halt_cleared', accountId: 2, severity: 'info' });
    expect(haltClearedEvents(2, ['manual'], ['manual', 'drawdown'], at)).toEqual([]);
  });
});

describe('authentication records', () => {
  const ev = (kind: string) => eventFromAuthEvent({ id: 3, kind, createdAt: 't' });
  it.each([
    ['login_success', 'login_success', 'info'],
    ['rate_limit_tripped', 'login_throttled', 'warning'],
    ['recovery_used', 'recovery_code_used', 'critical'],
    ['password_changed', 'password_changed', 'warning'],
    ['recovery_regenerated', 'security_settings_changed', 'warning'],
    ['ai_consent_on', 'security_settings_changed', 'warning'],
    ['ai_consent_off', 'security_settings_changed', 'warning'],
    ['ai_caps_changed', 'security_settings_changed', 'warning'],
    ['notifications_settings_changed', 'security_settings_changed', 'warning'],
    ['logout_all', 'logout_everywhere', 'warning'],
    ['step_up_failure', 'step_up_failed', 'warning'],
  ])('%s -> %s', (kind, mapped, severity) => {
    expect(ev(kind)).toMatchObject({
      kind: mapped,
      severity,
      category: 'security',
      dedupeKey: 'auth_event:3',
    });
  });
  it('single failed logins are NOT events (they are summarized); the final notice covers "off"', () => {
    for (const k of [
      'login_failure',
      'notifications_off',
      'owner_created',
      'logout',
      'session_revoked',
      'step_up_success',
    ]) {
      expect(ev(k), k).toBeNull();
    }
  });
});

describe('failed-login bursts', () => {
  const t = (m: number, s = 0) => new Date(Date.UTC(2026, 2, 10, 10, m, s)).toISOString();
  it('fewer than 3 failures in a 15-minute window give nothing', () => {
    expect(loginBurstEvents([t(0), t(5)])).toEqual([]);
  });
  it('3 or more in one window give ONE event with the count', () => {
    const e = loginBurstEvents([t(1), t(2), t(3), t(14, 59)]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'login_failures_burst', count: 4, severity: 'warning' });
    expect(e[0]?.dedupeKey).toBe('login_burst:2026-03-10T10:00:00.000Z:3');
  });
  it('failures spread over two windows are counted per window (the boundary is exact)', () => {
    expect(loginBurstEvents([t(13), t(14), t(15), t(16)])).toEqual([]);
    expect(
      loginBurstEvents([t(13), t(14), t(14, 59), t(15), t(16), t(17)]).map((e) => e.count),
    ).toEqual([3, 3]);
  });
  it('is idempotent: the same input gives the same keys', () => {
    const a = loginBurstEvents([t(1), t(2), t(3)]);
    expect(loginBurstEvents([t(1), t(2), t(3), t(4)])[0]?.dedupeKey).toBe(a[0]?.dedupeKey);
  });
  it('ignores unreadable times', () => {
    expect(loginBurstEvents(['x', 'y', 'z'])).toEqual([]);
  });
});

describe('analyst usage rows', () => {
  it('only failures are events', () => {
    expect(eventFromAnalystUsage({ id: 1, status: 'ok', createdAt: 't' })).toBeNull();
    for (const status of ['api_error', 'timeout', 'refused', 'truncated', 'invalid_output']) {
      expect(eventFromAnalystUsage({ id: 9, status, createdAt: 't' })).toMatchObject({
        kind: 'analyst_call_failed',
        dedupeKey: 'ai_usage:9',
      });
    }
  });
});

describe('makeEvent', () => {
  it('fills category and severity from the kind and level', () => {
    expect(
      makeEvent({
        kind: 'drawdown_usage',
        dedupeKey: 'k',
        occurredAt: 't',
        level: 80,
        accountId: 1,
      }),
    ).toEqual({
      kind: 'drawdown_usage',
      category: 'risk',
      severity: 'warning',
      dedupeKey: 'k',
      occurredAt: 't',
      accountId: 1,
      level: 80,
      count: null,
    });
  });
});

describe('the full table of kinds (category and severity are pinned)', () => {
  const table: Record<string, [string, string | string[]]> = {
    daily_loss_usage: ['risk', ['info', 'warning', 'critical']],
    open_risk_usage: ['risk', ['info', 'warning', 'critical']],
    open_trades_usage: ['risk', ['info', 'warning', 'critical']],
    drawdown_usage: ['risk', ['info', 'warning', 'critical']],
    halt_started_daily_loss: ['risk', 'critical'],
    halt_started_drawdown: ['risk', 'critical'],
    halt_started_manual: ['risk', 'warning'],
    halt_cleared: ['risk', 'info'],
    drawdown_reset_refused: ['risk', 'warning'],
    override_logged: ['risk', 'warning'],
    rule_violation_trade_logged: ['risk', 'warning'],
    login_failures_burst: ['security', 'warning'],
    login_throttled: ['security', 'warning'],
    login_success: ['security', 'info'],
    recovery_code_used: ['security', 'critical'],
    password_changed: ['security', 'warning'],
    security_settings_changed: ['security', 'warning'],
    logout_everywhere: ['security', 'warning'],
    step_up_failed: ['security', 'warning'],
    analyst_daily_calls_usage: ['analyst', ['info', 'warning', 'warning']],
    analyst_monthly_calls_usage: ['analyst', ['info', 'warning', 'warning']],
    analyst_monthly_cost_usage: ['analyst', ['info', 'warning', 'warning']],
    analyst_call_failed: ['analyst', 'info'],
    notifications_switched_off: ['system', 'critical'],
    test_message: ['system', 'info'],
    flood_summary: ['system', 'info'],
    backup_failed: ['system', 'warning'],
    market_data_stale: ['system', 'warning'],
  };
  it('lists exactly the defined kinds', () => {
    expect(Object.keys(table).sort()).toEqual([...EVENT_KINDS].sort());
  });
  it.each(Object.entries(table))('%s', (kind, [category, severity]) => {
    expect(KIND_CATEGORY[kind as keyof typeof KIND_CATEGORY]).toBe(category);
    if (Array.isArray(severity)) {
      expect([50, 80, 100].map((l) => severityOf(kind as never, l))).toEqual(severity);
    } else {
      expect(severityOf(kind as never, null)).toBe(severity);
      expect(severityOf(kind as never, 100)).toBe(severity);
    }
  });
  it('an unknown or inherited kind is never louder than info', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'nope'])
      expect(severityOf(k as never, 100)).toBe('info');
  });
});

describe('failed-login bursts: tiers and window edges', () => {
  const t = (m: number, s = 0, ms = 0) =>
    new Date(Date.UTC(2026, 2, 10, 10, m, s, ms)).toISOString();
  const many = (n: number, at = t(1)) => Array.from({ length: n }, () => at);
  it('the dedupe key carries the tier, so 500 failures are not stuck at "3"', () => {
    const key = (n: number) => loginBurstEvents(many(n))[0]?.dedupeKey.split(':').pop();
    expect([key(3), key(9), key(10), key(29), key(30), key(99), key(100), key(500)]).toEqual([
      '3',
      '3',
      '10',
      '10',
      '30',
      '30',
      '100',
      '100',
    ]);
    expect(loginBurstEvents(many(40))[0]?.count).toBe(40);
  });
  it('the same window announced again only when a higher tier is reached', () => {
    const a = loginBurstEvents(many(3))[0]?.dedupeKey;
    expect(loginBurstEvents(many(9))[0]?.dedupeKey).toBe(a);
    expect(loginBurstEvents(many(10))[0]?.dedupeKey).not.toBe(a);
  });
  it('window edges are exact: :00.000 starts one, :14:59.999 ends it, :15:00.000 starts the next', () => {
    const e = loginBurstEvents([t(0, 0, 0), t(7), t(14, 59, 999), t(15, 0, 0), t(20), t(25)]);
    expect(e.map((x) => [x.occurredAt, x.count])).toEqual([
      [t(0), 3],
      [t(15), 3],
    ]);
  });
  it('rolls over midnight and a year end, is independent of the time zone, and sorts by window', () => {
    const e = loginBurstEvents([
      '2026-12-31T23:59:59.999Z',
      '2026-12-31T23:50:00.000Z',
      '2026-12-31T23:45:00.000Z',
      '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:01:00.000Z',
      '2027-01-01T00:02:00.000Z',
    ]);
    expect(e.map((x) => x.occurredAt)).toEqual([
      '2026-12-31T23:45:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
  });
});

describe('halt_cleared events', () => {
  const at = new Date('2026-03-11T00:00:00.000Z');
  it('two halts that end together give two events with different keys; nothing for an empty or unchanged list', () => {
    const e = haltClearedEvents(2, ['daily_loss', 'manual'], [], at);
    expect(e).toHaveLength(2);
    expect(new Set(e.map((x) => x.dedupeKey)).size).toBe(2);
    expect(haltClearedEvents(2, [], ['manual'], at)).toEqual([]);
    expect(haltClearedEvents(2, ['manual'], ['manual'], at)).toEqual([]);
  });
});

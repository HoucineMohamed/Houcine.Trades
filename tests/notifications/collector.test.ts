import { describe, expect, it } from 'vitest';
import { appendAuthEvent } from '@/data/auth';
import { insertEvents, listRecentEvents, loadOutbox, readAllState } from '@/data/notifications';
import { haltManually, resetHalt } from '@/data/risk';
import { appendRiskEvent } from '@/data/risk-events';
import { recordUsage } from '@/data/analyst';
import { createTrade } from '@/data/trades';
import { collectEvents, collectorBaseline } from '@/notifications/collector';
import { freshAuthForTests } from '../helpers/auth';
import { setNotificationsMaster } from '@/data/notifications';
import { enableAlerts } from '../helpers/notifications';
import { closedTrade, riskDb } from '../helpers/risk';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const ms = (n: number) => new Date(NOW.getTime() + n);
const today = '2026-03-10T09:00:00.000Z';

const kinds = (db: ReturnType<typeof riskDb>, now = NOW) =>
  listRecentEvents(db, now, 100)
    .map((r) => (r.event.level ? `${r.event.kind}:${r.event.level}` : r.event.kind))
    .reverse();

function open(db: ReturnType<typeof riskDb>) {
  return createTrade(
    db,
    {
      accountId: 1,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100000',
      stopLoss: '99900',
      size: '0.01',
      quoteCurrency: 'USDT',
      entryPrice: '100000',
      openedAt: '2026-03-10T08:00:00Z',
    },
    { now: () => NOW },
  );
}

describe('before alerts were ever switched on', () => {
  it('collects nothing (only events from the moment of switching on are announced)', () => {
    const db = riskDb();
    closedTrade(db, { pnl: -250, closedAt: today });
    expect(collectEvents(db, NOW)).toEqual({ recorded: 0, problems: [], notBaselined: true });
    expect(loadOutbox(db, NOW)).toEqual([]);
  });
});

describe('risk limits: levels 50, 80 and 100 percent (daily loss limit is 300 of 10000)', () => {
  it('announces each level once as the loss grows, and a halt when the limit is reached', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    closedTrade(db, { pnl: -150, closedAt: today }); // 50 %
    collectEvents(db, ms(1000));
    closedTrade(db, { pnl: -100, closedAt: today }); // 250 -> 83 %
    collectEvents(db, ms(2000));
    collectEvents(db, ms(3000)); // nothing new
    closedTrade(db, { pnl: -50, closedAt: today }); // 300 -> 100 %
    collectEvents(db, ms(4000));
    const k = kinds(db, ms(5000));
    expect(k.filter((x) => x.startsWith('daily_loss_usage'))).toEqual([
      'daily_loss_usage:50',
      'daily_loss_usage:80',
      'daily_loss_usage:100',
    ]);
    // the halt itself is recorded by the risk engine when something syncs it; the usage events do not need it
  });

  it('a level that already existed when alerts were switched on is NOT announced', () => {
    const db = riskDb();
    closedTrade(db, { pnl: -250, closedAt: today }); // 83 % before switching on
    enableAlerts(db, NOW);
    expect(collectEvents(db, ms(1000)).recorded).toBe(0);
    closedTrade(db, { pnl: -50, closedAt: today }); // reaches 100 %
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000))).toEqual(['daily_loss_usage:100']);
  });

  it('open trades: 2 of 3 is 66 % (level 50), 3 of 3 is reached', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    open(db);
    open(db);
    collectEvents(db, ms(1000));
    open(db);
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000)).filter((x) => x.startsWith('open_trades'))).toEqual([
      'open_trades_usage:50',
      'open_trades_usage:100',
    ]);
  });

  it('a limit that falls and rises again is announced again, but not twice within an hour', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    open(db);
    open(db);
    collectEvents(db, ms(1000)); // 50 announced
    db.$client.prepare("UPDATE trades SET status = 'cancelled' WHERE id IN (1, 2)").run(); // back to 0 (test shortcut)
    collectEvents(db, ms(2000));
    open(db);
    open(db);
    collectEvents(db, ms(3000)); // 50 again, within the hour: not announced
    expect(kinds(db, ms(4000)).filter((x) => x.startsWith('open_trades'))).toEqual([
      'open_trades_usage:50',
    ]);
    collectEvents(db, ms(3_700_000)); // nothing falls in between: still the same level
    expect(kinds(db, ms(3_700_000)).filter((x) => x.startsWith('open_trades'))).toEqual([
      'open_trades_usage:50',
    ]);
  });

  it('running the collector twice never duplicates (dedupe key)', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    closedTrade(db, { pnl: -160, closedAt: today });
    collectEvents(db, ms(1000));
    const n = loadOutbox(db, ms(2000)).length;
    collectEvents(db, ms(2000));
    collectEvents(db, ms(2500));
    expect(loadOutbox(db, ms(3000))).toHaveLength(n);
  });
});

describe('halts', () => {
  it('a halt started and a halt cleared', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    haltManually(db, 1, 'testing the kill switch', ms(1000));
    collectEvents(db, ms(2000));
    resetHalt(
      db,
      1,
      'manual',
      { confirm: 'RESET', reason: 'rested and reviewed' },
      freshAuthForTests(1, ms(3000)),
      ms(3000),
    );
    collectEvents(db, ms(4000));
    const k = kinds(db, ms(5000));
    expect(k).toContain('halt_started_manual');
    expect(k).toContain('halt_cleared');
    expect(k.indexOf('halt_started_manual')).toBeLessThan(k.indexOf('halt_cleared'));
    expect(
      listRecentEvents(db, ms(5000), 10).find((r) => r.event.kind === 'halt_cleared')?.event
        .accountId,
    ).toBe(1);
  });

  it('a halt that already existed when alerts were switched on is not announced as new, but its end is', () => {
    const db = riskDb();
    haltManually(db, 1, 'before', ms(-5000));
    enableAlerts(db, NOW);
    expect(collectEvents(db, ms(1000)).recorded).toBe(0);
    resetHalt(
      db,
      1,
      'manual',
      { confirm: 'RESET', reason: 'rested and reviewed' },
      freshAuthForTests(1, ms(2000)),
      ms(2000),
    );
    collectEvents(db, ms(3000));
    expect(kinds(db, ms(4000))).toEqual(['halt_cleared']);
  });

  it('a refused drawdown reset, an override and a rule-violating trade', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    appendRiskEvent(db, {
      accountId: 1,
      kind: 'reset_refused',
      haltKind: 'drawdown',
      reason: 'too early',
      at: ms(1000),
    });
    appendRiskEvent(db, { accountId: 1, kind: 'override', reason: 'I was sure', at: ms(1500) });
    const t = open(db);
    db.$client
      .prepare(
        "INSERT INTO risk_verdicts (trade_id, stage, approved, violation_codes, warning_codes, snapshot_json, override_reason, created_at) VALUES (?, 'created', 0, '[]', '[]', '{}', 'because', 't')",
      )
      .run(t.id);
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000))).toEqual(
      expect.arrayContaining([
        'drawdown_reset_refused',
        'override_logged',
        'rule_violation_trade_logged',
      ]),
    );
  });
});

describe('security events', () => {
  const auth = (
    db: ReturnType<typeof riskDb>,
    kind: Parameters<typeof appendAuthEvent>[1]['kind'],
    at: Date,
  ) => appendAuthEvent(db, { kind, now: at });

  it('a successful login, a recovery code, a password change, logout everywhere, a failed step-up', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    for (const k of [
      'login_success',
      'recovery_used',
      'password_changed',
      'logout_all',
      'step_up_failure',
      'recovery_regenerated',
    ] as const)
      auth(db, k, ms(1000));
    auth(db, 'logout', ms(1000)); // not an event
    auth(db, 'session_revoked', ms(1000)); // not an event
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000))).toEqual([
      'login_success',
      'recovery_code_used',
      'password_changed',
      'logout_everywhere',
      'step_up_failed',
      'security_settings_changed',
    ]);
  });

  it('failed logins are summarized, never one by one', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    auth(db, 'login_failure', ms(1000));
    auth(db, 'login_failure', ms(2000));
    collectEvents(db, ms(3000));
    expect(kinds(db, ms(4000))).toEqual([]); // 2 failures: nothing
    auth(db, 'login_failure', ms(5000));
    auth(db, 'login_failure', ms(6000));
    collectEvents(db, ms(7000));
    collectEvents(db, ms(8000));
    const rows = listRecentEvents(db, ms(9000), 10);
    expect(rows.map((r) => r.event.kind)).toEqual(['login_failures_burst']);
    expect(rows[0]?.event.count).toBe(4);
  });

  it('a throttle trip is its own event', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    auth(db, 'rate_limit_tripped', ms(1000));
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000))).toEqual(['login_throttled']);
  });

  it('the notification settings logged in auth_events become security-setting events, the final notice covers "off"', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    auth(db, 'notifications_settings_changed', ms(1000));
    auth(db, 'notifications_off', ms(1000));
    collectEvents(db, ms(2000));
    expect(kinds(db, ms(3000))).toEqual(['security_settings_changed']);
  });
});

describe('analyst events', () => {
  const usage = (db: ReturnType<typeof riskDb>, status: 'ok' | 'api_error', at: Date) =>
    recordUsage(db, {
      at,
      feature: 'tutor',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: '0.000001',
      status,
    });

  it('a failed call is an event; an ok call is not', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    usage(db, 'ok', ms(1000));
    usage(db, 'api_error', ms(2000));
    collectEvents(db, ms(3000));
    expect(kinds(db, ms(4000))).toEqual(['analyst_call_failed']);
  });

  it('the daily call cap: nothing at 50 %, announced at 80 % and at 100 %', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    for (let i = 0; i < 10; i++) usage(db, 'ok', ms(1000 + i)); // 10 of 20 = 50 %
    collectEvents(db, ms(5000));
    expect(kinds(db, ms(6000))).toEqual([]);
    for (let i = 0; i < 6; i++) usage(db, 'ok', ms(7000 + i)); // 16 of 20 = 80 %
    collectEvents(db, ms(8000));
    for (let i = 0; i < 4; i++) usage(db, 'ok', ms(9000 + i)); // 20 of 20
    collectEvents(db, ms(10_000));
    expect(kinds(db, ms(11_000)).filter((x) => x.startsWith('analyst_daily'))).toEqual([
      'analyst_daily_calls_usage:80',
      'analyst_daily_calls_usage:100',
    ]);
    expect(listRecentEvents(db, ms(11_000), 10).every((r) => r.event.severity === 'warning')).toBe(
      true,
    );
  });
});

describe('robustness and boundaries', () => {
  it('a section that cannot be read is reported, skipped and retried; the others still work', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    appendAuthEvent(db, { kind: 'login_success', now: ms(1000) });
    db.$client.exec('DROP TABLE ai_reviews; ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    const r = collectEvents(db, ms(2000));
    expect(r.problems).toEqual(expect.arrayContaining(['ai_usage']));
    expect(kinds(db, ms(3000))).toEqual(['login_success']);
  });

  it('writes nothing outside the notification tables (no trade, risk or auth row is touched)', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    closedTrade(db, { pnl: -250, closedAt: today });
    appendAuthEvent(db, { kind: 'login_success', now: ms(1000) });
    const tables = [
      'trades',
      'risk_events',
      'risk_verdicts',
      'risk_settings',
      'auth_events',
      'sessions',
      'accounts',
      'ai_usage',
      'ai_settings',
    ];
    const snap = () =>
      Object.fromEntries(
        tables.map((t) => [t, JSON.stringify(db.$client.prepare(`SELECT * FROM ${t}`).all())]),
      );
    const before = snap();
    collectEvents(db, ms(2000));
    expect(snap()).toEqual(before);
  });

  it('keeps its bookkeeping in the database, so a restart loses and repeats nothing', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    appendAuthEvent(db, { kind: 'login_success', now: ms(1000) });
    collectEvents(db, ms(2000));
    expect(Object.keys(readAllState(db))).toEqual(
      expect.arrayContaining(['wm:risk', 'wm:auth', 'wm:usage', 'wm:verdict']),
    );
    const Ctor = db.$client.constructor as new (b: Buffer) => typeof db.$client;
    const copy = new Ctor(db.$client.serialize());
    expect(
      (copy.prepare('SELECT count(*) AS c FROM notification_events').get() as { c: number }).c,
    ).toBe(1);
  });

  it('collectorBaseline is read-only', () => {
    const db = riskDb();
    const before = JSON.stringify(db.$client.prepare('SELECT * FROM notification_state').all());
    collectorBaseline(db, NOW);
    expect(JSON.stringify(db.$client.prepare('SELECT * FROM notification_state').all())).toBe(
      before,
    );
  });

  it('an unknown halt kind or a damaged state is never guessed', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    db.$client
      .prepare(
        "INSERT INTO notification_state (key, value_json, updated_at) VALUES ('halts:1', 'junk', 't') ON CONFLICT(key) DO UPDATE SET value_json = 'junk'",
      )
      .run();
    expect(() => collectEvents(db, ms(1000))).not.toThrow();
    expect(insertEvents(db, [], NOW)).toBe(0);
  });
});

describe('switching off and on again never drops a usage alert (the epoch carries over)', () => {
  it('an 80 % that was announced, then OFF, then ON with usage back below, then 80 % again, is announced again', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    open(db);
    open(db);
    open(db); // 3 of 3 -> level 100 announced
    collectEvents(db, ms(1000));
    expect(kinds(db, ms(2000)).filter((x) => x.startsWith('open_trades'))).toEqual([
      'open_trades_usage:100',
    ]);
    // OFF, then everything closes, then ON again with a fresh baseline
    setNotificationsMaster(db, false, freshAuthForTests(1, ms(3000)), ms(3000));
    db.$client.prepare("UPDATE trades SET status = 'cancelled'").run();
    setNotificationsMaster(
      db,
      true,
      freshAuthForTests(1, ms(4000)),
      ms(4000),
      {},
      collectorBaseline(db, ms(4000)).state,
    );
    open(db);
    open(db);
    open(db); // 100 % again, no fall seen by the collector in between
    collectEvents(db, ms(3_700_000)); // past the one-hour cooldown
    expect(kinds(db, ms(3_800_000)).filter((x) => x.startsWith('open_trades'))).toEqual([
      'open_trades_usage:100',
      'open_trades_usage:100',
    ]);
  });
  it('the baseline carries the epoch forward and is refused when part of the state cannot be read', () => {
    const db = riskDb();
    const a = collectorBaseline(db, NOW);
    expect(a.problems).toEqual([]);
    const key = Object.keys(a.state).find((k) => k.startsWith('limit:daily_loss_usage'));
    expect(JSON.parse(a.state[key as string] as string).epoch).toBe(0);
    enableAlerts(db, NOW);
    const b = collectorBaseline(db, ms(1000));
    expect(JSON.parse(b.state[key as string] as string).epoch).toBe(1);
    db.$client.exec('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    expect(collectorBaseline(db, ms(2000)).problems).toEqual(['logs_unreadable', 'analyst_usage']);
  });
});

describe('problems are named, never silent', () => {
  it('an unreadable analyst setting and an unverifiable account are reported with their own codes', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    db.$client.prepare("UPDATE ai_settings SET caps_json = 'junk'").run();
    db.$client.exec(
      "INSERT OR REPLACE INTO ai_settings (id, consent, caps_json, updated_at) VALUES (1, 0, 'junk', 't')",
    );
    expect(collectEvents(db, ms(1000)).problems).toContain('analyst_settings');
  });
});

describe('failed-login bursts only count what happened after alerts were switched on', () => {
  it('failures from before switch-on are not announced; later ones are, with the real count', () => {
    const db = riskDb();
    for (let i = 0; i < 5; i++)
      appendAuthEvent(db, { kind: 'login_failure', now: ms(-60_000 + i) });
    enableAlerts(db, NOW);
    collectEvents(db, ms(1000));
    expect(kinds(db, ms(2000))).toEqual([]);
    for (let i = 0; i < 12; i++) appendAuthEvent(db, { kind: 'login_failure', now: ms(2000 + i) });
    collectEvents(db, ms(5000));
    const rows = listRecentEvents(db, ms(6000), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.count).toBe(12);
    appendAuthEvent(db, { kind: 'login_failure', now: ms(5500) });
    collectEvents(db, ms(7000)); // same tier: nothing new
    expect(listRecentEvents(db, ms(8000), 10)).toHaveLength(1);
  });
  it('a burst is still found after a long worker outage (up to 24 hours back)', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    for (let i = 0; i < 4; i++) appendAuthEvent(db, { kind: 'login_failure', now: ms(10_000 + i) });
    collectEvents(db, ms(3 * 3600_000));
    expect(kinds(db, ms(3 * 3600_000))).toEqual(['login_failures_burst']);
  });
});

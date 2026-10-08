import { describe, expect, it } from 'vitest';
import { makeEvent } from './events';
import { EVENT_KINDS, USAGE_KINDS, USAGE_LEVELS } from './kinds';
import { messageFor } from './messages';

const msg = (
  kind: (typeof EVENT_KINDS)[number],
  over: { level?: 50 | 80 | 100; count?: number; accountId?: number } = {},
) => messageFor(makeEvent({ kind, dedupeKey: 'k', occurredAt: 't', ...over }));

describe('golden messages (exact text)', () => {
  it.each([
    [
      'daily_loss_usage',
      { level: 50, accountId: 2 },
      'Houcine.Trades (paper): Daily loss limit: 50 % of the limit is used (account #2).',
    ],
    [
      'daily_loss_usage',
      { level: 80, accountId: 2 },
      'Houcine.Trades (paper): Daily loss limit: 80 % of the limit is used (account #2).',
    ],
    [
      'daily_loss_usage',
      { level: 100, accountId: 2 },
      'Houcine.Trades (paper): Daily loss limit: reached (100 % of the limit) (account #2).',
    ],
    [
      'open_risk_usage',
      { level: 80, accountId: 1 },
      'Houcine.Trades (paper): Open risk limit: 80 % of the limit is used (account #1).',
    ],
    [
      'open_trades_usage',
      { level: 100, accountId: 1 },
      'Houcine.Trades (paper): Open trades limit: reached (100 % of the limit) (account #1).',
    ],
    [
      'drawdown_usage',
      { level: 50, accountId: 3 },
      'Houcine.Trades (paper): Drawdown limit: 50 % of the limit is used (account #3).',
    ],
    [
      'halt_started_daily_loss',
      { accountId: 2 },
      'Houcine.Trades (paper): Trading is halted: the daily loss limit was reached (account #2).',
    ],
    [
      'halt_started_drawdown',
      { accountId: 2 },
      'Houcine.Trades (paper): Trading is halted: the drawdown limit was reached (account #2).',
    ],
    [
      'halt_started_manual',
      { accountId: 2 },
      'Houcine.Trades (paper): Trading was halted by hand (account #2).',
    ],
    [
      'halt_cleared',
      { accountId: 2 },
      'Houcine.Trades (paper): A trading halt ended (account #2).',
    ],
    [
      'drawdown_reset_refused',
      { accountId: 2 },
      'Houcine.Trades (paper): A reset of the drawdown halt was refused (account #2).',
    ],
    [
      'override_logged',
      { accountId: 2 },
      'Houcine.Trades (paper): A refused plan was logged anyway (override) (account #2).',
    ],
    [
      'rule_violation_trade_logged',
      { accountId: 2 },
      'Houcine.Trades (paper): A trade that breaks a risk rule was logged (account #2).',
    ],
    [
      'login_failures_burst',
      { count: 5 },
      'Houcine.Trades (paper): 5 failed sign-in attempts within 15 minutes.',
    ],
    [
      'login_throttled',
      {},
      'Houcine.Trades (paper): Sign-in attempts were slowed down after repeated failures.',
    ],
    ['login_success', {}, 'Houcine.Trades (paper): A sign-in succeeded.'],
    ['recovery_code_used', {}, 'Houcine.Trades (paper): A recovery code was used to sign in.'],
    ['password_changed', {}, 'Houcine.Trades (paper): The password was changed.'],
    ['security_settings_changed', {}, 'Houcine.Trades (paper): A security setting was changed.'],
    ['logout_everywhere', {}, 'Houcine.Trades (paper): Every session was signed out.'],
    ['step_up_failed', {}, 'Houcine.Trades (paper): A fresh-code check failed.'],
    [
      'analyst_daily_calls_usage',
      { level: 80 },
      'Houcine.Trades (paper): Analyst daily call cap: 80 % of the limit is used.',
    ],
    [
      'analyst_monthly_calls_usage',
      { level: 100 },
      'Houcine.Trades (paper): Analyst monthly call cap: reached (100 % of the limit).',
    ],
    [
      'analyst_monthly_cost_usage',
      { level: 80 },
      'Houcine.Trades (paper): Analyst monthly cost cap (estimate): 80 % of the limit is used.',
    ],
    ['analyst_call_failed', {}, 'Houcine.Trades (paper): An analyst request failed.'],
    ['notifications_switched_off', {}, 'Houcine.Trades (paper): Alerts were switched off.'],
    [
      'test_message',
      {},
      'Houcine.Trades (paper): Test message. If you can read this, alerts reach you.',
    ],
    [
      'flood_summary',
      { count: 12 },
      'Houcine.Trades (paper): 12 more events are waiting. Open the Notifications page to see them.',
    ],
    ['backup_failed', {}, 'Houcine.Trades (paper): A backup failed.'],
    ['backup_succeeded', {}, 'Houcine.Trades (paper): A backup finished and was verified.'],
    ['backup_stale', {}, 'Houcine.Trades (paper): No verified backup for a day and a half.'],
    [
      'migration_applied',
      {},
      'Houcine.Trades (paper): A database update was applied, after a verified backup.',
    ],
    [
      'migration_failed',
      {},
      'Houcine.Trades (paper): A database update failed. The old database was kept and the app did not start.',
    ],
    ['restore_applied', {}, 'Houcine.Trades (paper): A backup was restored.'],
    ['market_data_stale', {}, 'Houcine.Trades (paper): Market data is out of date.'],
  ] as const)('%s %j', (kind, over, text) => {
    expect(msg(kind, over as never)).toBe(text);
  });

  it('every event kind has a template (none falls back to the generic text)', () => {
    for (const kind of EVENT_KINDS) {
      const level = (USAGE_KINDS as readonly string[]).includes(kind) ? 80 : undefined;
      expect(msg(kind, { level, count: 3, accountId: 1 }), kind).not.toContain('An event happened');
    }
  });
});

describe('what a message can never contain', () => {
  const all = EVENT_KINDS.flatMap((kind) =>
    [undefined, ...USAGE_LEVELS].map((level) => msg(kind, { level, count: 7, accountId: 4 })),
  );
  it('is plain text: no links, markup, markdown or buttons', () => {
    for (const m of all) {
      expect(m, m).not.toMatch(/https?:|www\.|t\.me|<|>|\*|_|`|\[|\]|\(http|&[a-z]+;/i);
      expect(m.length).toBeLessThan(200);
    }
  });
  it('never carries an email, an address, a key, a token, an amount or a price-like number', () => {
    for (const m of all) {
      expect(m, m).not.toMatch(
        /@|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|sk-|\d+:[A-Za-z0-9_-]{20,}/,
      );
      // the only digits are the level, a count and an account number
      const numbers = m.replace('Houcine.Trades', '').match(/\d+(?:\.\d+)?/g) ?? [];
      for (const n of numbers) expect(['0', '4', '7', '50', '80', '100', '15']).toContain(n);
    }
  });
  it('ignores hostile or oversized values (an account name or a float cannot be passed in)', () => {
    const m = messageFor({
      kind: 'halt_cleared',
      level: null,
      count: 1.5,
      accountId: 'Main <b>account</b>' as never,
    });
    expect(m).toBe('Houcine.Trades (paper): A trading halt ended.');
    expect(
      messageFor({ kind: 'login_failures_burst', level: null, count: -3, accountId: null }),
    ).toContain('0 failed');
    expect(
      messageFor({ kind: 'flood_summary', level: null, count: 9e12, accountId: null }),
    ).toContain('0 more');
    expect(
      messageFor({ kind: 'daily_loss_usage', level: 77 as never, count: null, accountId: 1 }),
    ).toContain('0 % of the limit');
  });
});

describe('inherited and hostile values never reach a message', () => {
  const generic = 'Houcine.Trades (paper): An event happened.';
  it.each([
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'x',
    '',
  ])('an unknown or inherited kind "%s" gives the generic sentence', (kind) => {
    expect(messageFor({ kind: kind as never, level: 50, count: 3, accountId: 1 })).toBe(generic);
  });
  it.each([0, -1, 1.5, Number.NaN, Infinity, 1e21, 2 ** 53, '7', '7; <script>', true, {}, null])(
    'an account id of %j adds no account text',
    (id) => {
      expect(
        messageFor({ kind: 'halt_cleared', level: null, count: null, accountId: id as never }),
      ).toBe('Houcine.Trades (paper): A trading halt ended.');
    },
  );
  it('account ids and counts are shown only up to 1,000,000', () => {
    const acct = (id: number) =>
      messageFor({ kind: 'halt_cleared', level: null, count: null, accountId: id });
    expect(acct(999_999)).toContain('#999999');
    expect(acct(1_000_000)).toContain('#1000000');
    expect(acct(1_000_001)).not.toContain('#');
    const count = (n: unknown) =>
      messageFor({ kind: 'login_failures_burst', level: null, count: n as never, accountId: null });
    expect(count(1_000_000)).toContain('1000000 failed');
    expect(count(1_000_001)).toContain('0 failed');
    expect(count('5; DROP')).toContain('0 failed');
  });
  it('a level that is not 50, 80 or 100 is shown as 0, and 100 as "reached"', () => {
    const lv = (l: unknown) =>
      messageFor({ kind: 'open_risk_usage', level: l as never, count: null, accountId: 1 });
    expect(lv(77)).toContain(': 0 % of the limit');
    expect(lv('80')).toContain(': 0 % of the limit');
    expect(lv(100)).toContain('reached (100 % of the limit)');
  });
});

import { describe, expect, it } from 'vitest';
import { appendAuthEvent } from '@/data/auth';
import { createAccount } from '@/data/accounts';
import { createSetup } from '@/data/setups';
import {
  getNotificationSettings,
  insertEvents,
  listRecentEvents,
  loadOutbox,
  setNotificationsMaster,
  updateNotificationSettings,
} from '@/data/notifications';
import { createTrade, closeTrade } from '@/data/trades';
import { makeEvent, messageFor, NOTIFY_LIMITS, type EventKind } from '@/domain/notifications';
import { collectEvents } from '@/notifications/collector';
import { deliverPending, sendTestMessage } from '@/notifications/delivery';
import { freshAuthForTests } from '../helpers/auth';
import { enableAlerts, failSend, fakeChannel } from '../helpers/notifications';
import { riskDb } from '../helpers/risk';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const noSleep = async () => undefined;

function setup(master = true) {
  const db = riskDb();
  if (master) enableAlerts(db, T0);
  let current = T0;
  const clock = () => current;
  const at = (ms: number) => {
    current = new Date(T0.getTime() + ms);
  };
  return { db, clock, at, opts: { clock, sleep: noSleep } };
}
const ev = (n: number, kind: EventKind = 'login_success', occurredMs = 0, level?: 50 | 80 | 100) =>
  makeEvent({
    kind,
    dedupeKey: `k${n}`,
    occurredAt: new Date(T0.getTime() + occurredMs).toISOString(),
    level: level ?? null,
  });
const add = (db: ReturnType<typeof riskDb>, ...events: ReturnType<typeof ev>[]) =>
  insertEvents(db, events, T0);
const statuses = (db: ReturnType<typeof riskDb>, now: Date) =>
  listRecentEvents(db, now, 100)
    .map((r) => r.status)
    .reverse();

describe('nothing is sent unless alerts are ON and the channel is set up', () => {
  it('master switch OFF (the default): pending events stay unsent and the channel is never called', async () => {
    const { db, opts } = setup(false);
    add(db, ev(1), ev(2, 'halt_started_daily_loss'));
    const ch = fakeChannel();
    const r = await deliverPending(db, ch, opts);
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: null });
    expect(ch.calls).toBe(0);
    expect(loadOutbox(db, T0)).toHaveLength(2);
  });
  it('no token (no channel): nothing is attempted, the events wait', async () => {
    const { db, opts } = setup();
    add(db, ev(1));
    const r = await deliverPending(db, null, opts);
    expect(r.skipped).toBe('channel_not_configured');
    expect(db.$client.prepare('SELECT count(*) AS c FROM notification_deliveries').get()).toEqual({
      c: 0,
    });
  });
  it('unreadable settings: nothing is sent', async () => {
    const { db, opts } = setup();
    add(db, ev(1));
    db.$client.prepare("UPDATE notification_settings SET categories_json = 'junk'").run();
    const ch = fakeChannel();
    expect((await deliverPending(db, ch, opts)).skipped).toBe('settings_unreadable');
    expect(ch.calls).toBe(0);
  });
  it('the test message needs the switch ON', async () => {
    const off = setup(false);
    const ch = fakeChannel();
    expect(await sendTestMessage(off.db, ch, off.opts)).toEqual({
      ok: false,
      reason: 'off',
      code: null,
    });
    expect(ch.calls).toBe(0);
    const on = setup();
    expect(await sendTestMessage(on.db, null, on.opts)).toMatchObject({
      ok: false,
      reason: 'channel_not_configured',
    });
  });
});

describe('delivery', () => {
  it('sends each pending event once, as its fixed template, and logs a "sent" attempt', async () => {
    const { db, opts } = setup();
    add(db, ev(1, 'login_success'), ev(2, 'daily_loss_usage', 0, 80));
    const ch = fakeChannel();
    const r = await deliverPending(db, ch, opts);
    expect(r).toMatchObject({ sent: 2, failed: 0 });
    expect(ch.sent).toEqual([
      messageFor({ kind: 'login_success', level: null, count: null, accountId: null }),
      messageFor({ kind: 'daily_loss_usage', level: 80, count: null, accountId: null }),
    ]);
    expect(statuses(db, T0)).toEqual(['sent', 'sent']);
    expect((await deliverPending(db, ch, opts)).sent).toBe(0); // never twice
    expect(ch.calls).toBe(2);
  });
  it('pauses between messages (one per second to one chat)', async () => {
    const { db, clock } = setup();
    add(db, ev(1), ev(2), ev(3));
    const pauses: number[] = [];
    await deliverPending(db, fakeChannel(), { clock, sleep: async (m) => void pauses.push(m) });
    expect(pauses).toEqual([1100, 1100]);
  });
  it('the test message is delivered and reported', async () => {
    const { db, opts } = setup();
    const ch = fakeChannel();
    expect(await sendTestMessage(db, ch, opts)).toEqual({ ok: true });
    expect(ch.sent).toEqual([
      'Houcine.Trades (paper): Test message. If you can read this, alerts reach you.',
    ]);
    const bad = fakeChannel(failSend('forbidden'));
    const s2 = setup();
    expect(await sendTestMessage(s2.db, bad, s2.opts)).toEqual({
      ok: false,
      reason: 'failed',
      code: 'forbidden',
    });
  });
});

describe('failures lose nothing: capped backoff, maximum age, every attempt logged', () => {
  it('a failed event is kept, retried after the backoff, and delivered when the channel recovers', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1));
    const ch = fakeChannel([failSend('network'), failSend('timeout'), { ok: true }]);
    await deliverPending(db, ch, opts); // fails
    expect(ch.calls).toBe(1);
    at(30_000);
    await deliverPending(db, ch, opts); // too early: 1 minute backoff
    expect(ch.calls).toBe(1);
    at(61_000);
    await deliverPending(db, ch, opts); // fails again
    expect(ch.calls).toBe(2);
    at(61_000 + 119_000);
    await deliverPending(db, ch, opts); // 2-minute backoff not over
    expect(ch.calls).toBe(2);
    at(61_000 + 121_000);
    expect((await deliverPending(db, ch, opts)).sent).toBe(1);
    const attempts = db.$client
      .prepare('SELECT status, error_code FROM notification_deliveries ORDER BY id')
      .all();
    expect(attempts.filter((a) => (a as { status: string }).status !== 'sending')).toEqual([
      { status: 'failed', error_code: 'network' },
      { status: 'failed', error_code: 'timeout' },
      { status: 'sent', error_code: null },
    ]);
  });
  it('the wait is capped at 30 minutes', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1));
    const ch = fakeChannel(failSend('network'));
    let t = 0;
    for (let i = 0; i < 9; i++) {
      at(t);
      await deliverPending(db, ch, opts);
      t += 31 * 60_000; // always past the cap
    }
    expect(ch.calls).toBe(9);
    const gaps = listRecentEvents(db, new Date(T0.getTime() + t), 1)[0];
    expect(gaps?.failures).toBe(9);
  });
  it('after 24 hours an undelivered event is expired: never sent, but still recorded and shown', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1));
    const ch = fakeChannel(failSend('network'));
    await deliverPending(db, ch, opts);
    at(NOTIFY_LIMITS.maxAgeMs + 1000);
    await deliverPending(db, ch, opts);
    expect(ch.calls).toBe(1);
    expect(statuses(db, new Date(T0.getTime() + NOTIFY_LIMITS.maxAgeMs + 1000))).toEqual([
      'expired',
    ]);
    expect(db.$client.prepare('SELECT count(*) AS c FROM notification_events').get()).toEqual({
      c: 1,
    });
  });
  it('a channel that THROWS is recorded as a failed attempt and never rethrown', async () => {
    const { db, opts } = setup();
    add(db, ev(1));
    const ch = fakeChannel(
      new Error('connect failed to https://api.telegram.org/bot123:SECRET/sendMessage'),
    );
    await expect(deliverPending(db, ch, opts)).resolves.toMatchObject({ sent: 0, failed: 1 });
    const row = db.$client
      .prepare("SELECT status, error_code FROM notification_deliveries WHERE status = 'failed'")
      .get();
    expect(row).toEqual({ status: 'failed', error_code: 'unexpected' });
    expect(
      JSON.stringify(db.$client.prepare('SELECT * FROM notification_deliveries').all()),
    ).not.toContain('SECRET');
  });
  it('a rate-limit stops the cycle at once; the rest wait and honour the retry-after', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1), ev(2), ev(3));
    const ch = fakeChannel([{ ok: true }, failSend('rate_limited', 300)]);
    const r = await deliverPending(db, ch, opts);
    expect(ch.calls).toBe(2); // the third was not even tried
    expect(r).toMatchObject({ sent: 1, failed: 2 });
    at(200_000);
    expect((await deliverPending(db, ch, opts)).sent + ch.calls).toBe(2); // 5-minute wait: nothing yet
    at(301_000);
    await deliverPending(db, fakeChannel(), opts);
    expect(
      loadOutbox(db, new Date(T0.getTime() + 301_000)).filter(
        (i) => !i.attempts.some((a) => a.status === 'sent'),
      ),
    ).toHaveLength(0);
  });
  it('a crash between "claim" and "result" repeats the message later (at-least-once, never lost)', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1));
    db.$client
      .prepare(
        "INSERT INTO notification_deliveries (event_id, channel, status, at) VALUES (1, 'fake', 'sending', ?)",
      )
      .run(T0.toISOString());
    const ch = fakeChannel();
    at(30_000);
    await deliverPending(db, ch, opts);
    expect(ch.calls).toBe(0); // still in flight
    at(NOTIFY_LIMITS.staleSendingMs + 61_000);
    expect((await deliverPending(db, ch, opts)).sent).toBe(1);
  });
});

describe('flood protection', () => {
  it('above 20 an hour: 20 go out, ONE summary says how many wait, the rest stay in the outbox', async () => {
    const { db, at, opts } = setup();
    add(db, ...Array.from({ length: 25 }, (_, i) => ev(i + 1, 'login_success', i)));
    const ch = fakeChannel();
    await deliverPending(db, ch, opts);
    expect(ch.sent).toHaveLength(21);
    expect(ch.sent.filter((t) => t.includes('more events are waiting'))).toEqual([
      'Houcine.Trades (paper): 5 more events are waiting. Open the Notifications page to see them.',
    ]);
    at(60_000);
    await deliverPending(db, ch, opts);
    expect(ch.sent).toHaveLength(21); // still over the ceiling, and no second summary
    at(3_700_000);
    await deliverPending(db, ch, opts);
    expect(ch.sent).toHaveLength(26); // the 5 held events are delivered, nothing was lost
  });
  it('critical events may use the reserved quota, but still bounded', async () => {
    const { db, opts } = setup();
    add(db, ...Array.from({ length: 20 }, (_, i) => ev(i + 1, 'login_success', i)));
    const ch = fakeChannel();
    await deliverPending(db, ch, opts);
    add(
      db,
      ...Array.from({ length: 15 }, (_, i) => ev(100 + i, 'halt_started_daily_loss', 100 + i)),
    );
    await deliverPending(db, ch, opts);
    expect(ch.sent.filter((t) => t.includes('Trading is halted'))).toHaveLength(10);
  });
});

describe('the final notice when alerts are switched off', () => {
  it('is sent once even though the switch is off, and nothing else is', async () => {
    const { db, opts } = setup();
    add(db, ev(1)); // an ordinary pending event
    setNotificationsMaster(db, false, freshAuthForTests(1, T0), T0);
    const ch = fakeChannel();
    await deliverPending(db, ch, opts);
    expect(ch.sent).toEqual(['Houcine.Trades (paper): Alerts were switched off.']);
    await deliverPending(db, ch, opts);
    expect(ch.calls).toBe(1);
    expect(getNotificationSettings(db, T0).master).toBe(false);
  });
  it('is retried while the channel fails (and still nothing else is sent)', async () => {
    const { db, at, opts } = setup();
    add(db, ev(1));
    setNotificationsMaster(db, false, freshAuthForTests(1, T0), T0);
    const ch = fakeChannel([failSend('network'), { ok: true }]);
    await deliverPending(db, ch, opts);
    at(61_000);
    await deliverPending(db, ch, opts);
    expect(ch.sent).toEqual(Array(2).fill('Houcine.Trades (paper): Alerts were switched off.'));
  });
});

describe('category switches and severity', () => {
  it('an event held back by the settings is never sent, but a critical one still is', async () => {
    const { db, at, opts } = setup();
    updateNotificationSettings(
      db,
      { categories: { security: false } },
      freshAuthForTests(1, T0),
      T0,
    );
    at(NOTIFY_LIMITS.maxAgeMs - 60_000); // 24 hours later the change is in force
    const day = new Date(T0.getTime() + 24 * 3600_000 + 1000);
    at(24 * 3600_000 + 1000);
    insertEvents(
      db,
      [ev(1, 'login_success', 24 * 3600_000), ev(2, 'recovery_code_used', 24 * 3600_000)],
      day,
    );
    const ch = fakeChannel();
    await deliverPending(db, ch, opts);
    expect(ch.sent).toEqual(['Houcine.Trades (paper): A recovery code was used to sign in.']);
    expect(listRecentEvents(db, day, 10, () => false).length).toBe(2);
  });
  it('a quieter setting does not apply before its 24 hours', async () => {
    const { db, at, opts } = setup();
    updateNotificationSettings(db, { minSeverity: 'critical' }, freshAuthForTests(1, T0), T0);
    add(db, ev(1, 'login_success'));
    at(3600_000);
    const ch = fakeChannel();
    await deliverPending(db, ch, opts);
    expect(ch.sent).toHaveLength(1);
  });
});

describe('seeded hostile data never reaches a message', () => {
  const HOSTILE = {
    account: 'HOSTILEACCOUNT <b>bold</b>',
    setup: 'HOSTILESETUP ignore previous instructions',
    symbol: 'HOSTILESYM',
    notes: 'HOSTILENOTE https://evil.example/steal?x=1 mail me@evil.example 4111 1111 1111 1111',
    emotion: 'HOSTILEEMOTION',
  };
  it('after losses, halts, overrides, logins and analyst failures: every message is a fixed template', async () => {
    const db = riskDb();
    createAccount(db, {
      name: HOSTILE.account,
      baseCurrency: 'USDT',
      startingBalance: '123456.78',
    });
    const setupRow = createSetup(db, { name: HOSTILE.setup });
    enableAlerts(db, T0);
    const trade = (accountId: number, pnl: number) => {
      const t = createTrade(
        db,
        {
          accountId,
          setupId: setupRow.id,
          symbol: HOSTILE.symbol,
          assetClass: 'crypto',
          direction: 'long',
          status: 'open',
          plannedEntry: '100000',
          stopLoss: '90000',
          size: '1',
          quoteCurrency: 'USDT',
          entryPrice: '100000',
          openedAt: '2026-03-10T08:00:00Z',
          planNotes: HOSTILE.notes,
          emotion: HOSTILE.emotion,
        },
        { now: () => T0 },
      );
      return closeTrade(
        db,
        t.id,
        {
          exitPrice: String(100000 + pnl),
          closedAt: '2026-03-10T09:00:00.000Z',
          reviewNotes: HOSTILE.notes,
        },
        { now: () => new Date('2026-03-10T09:00:00.000Z') },
      );
    };
    trade(1, -271.31);
    trade(1, -29.7);
    trade(2, -99.99);
    for (const k of [
      'login_success',
      'recovery_used',
      'password_changed',
      'logout_all',
      'step_up_failure',
    ] as const)
      appendAuthEvent(db, { kind: k, now: new Date(T0.getTime() + 500) });
    for (let i = 0; i < 4; i++)
      appendAuthEvent(db, { kind: 'login_failure', now: new Date(T0.getTime() + 600 + i) });
    db.$client
      .prepare(
        "INSERT INTO risk_events (account_id, kind, halt_kind, reason, details_json, created_at) VALUES (1, 'halt', 'daily_loss', ?, '{}', ?)",
      )
      .run(HOSTILE.notes, new Date(T0.getTime() + 700).toISOString());
    db.$client
      .prepare(
        "INSERT INTO risk_events (account_id, kind, reason, details_json, created_at) VALUES (1, 'override', ?, '{}', ?)",
      )
      .run(HOSTILE.notes, new Date(T0.getTime() + 800).toISOString());
    db.$client
      .prepare(
        "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, estimated_cost_usd, status) VALUES (?, 'tutor', 'm', 1, 1, '0.5', 'api_error')",
      )
      .run(new Date(T0.getTime() + 900).toISOString());

    const later = new Date(T0.getTime() + 5000);
    collectEvents(db, later);
    const ch = fakeChannel();
    await deliverPending(db, ch, { clock: () => later, sleep: noSleep });

    expect(ch.sent.length).toBeGreaterThan(5);
    const forbidden = [
      'HOSTILE',
      'evil',
      'mailto',
      '@',
      'http',
      'bold',
      '<',
      '>',
      '4111',
      'ignore previous',
      '271',
      '29.7',
      '99.99',
      '123456',
      '100000',
      '90000',
      'BTC',
      'USDT',
      'Paper',
    ];
    for (const text of ch.sent) {
      for (const f of forbidden) expect(text, `${f} in: ${text}`).not.toContain(f);
      expect(text.startsWith('Houcine.Trades (paper): ')).toBe(true);
      expect(text).not.toMatch(/[*_`\[\]]/);
      // the only digits are a level, a count, an account number
      for (const n of text.replace('Houcine.Trades', '').match(/\d+/g) ?? [])
        expect(['1', '2', '4', '15', '50', '80', '100']).toContain(n);
    }
    // the stored events hold no free text either
    const cols = (
      db.$client.prepare('PRAGMA table_info(notification_events)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toEqual(expect.arrayContaining(['message']));
    expect(
      JSON.stringify(db.$client.prepare('SELECT * FROM notification_events').all()),
    ).not.toContain('HOSTILE');
    expect(
      JSON.stringify(db.$client.prepare('SELECT * FROM notification_deliveries').all()),
    ).not.toContain('HOSTILE');
  });
});

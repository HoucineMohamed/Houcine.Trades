import { describe, expect, it } from 'vitest';
import { listAuthEvents } from '@/data/auth';
import {
  claimDue,
  countExpiredUnsent,
  currentMaxIds,
  findEventByKey,
  getHealthInput,
  getNotificationSettings,
  insertEvents,
  listRecentEvents,
  loadHealth,
  loadOutbox,
  logChannelChange,
  readAllState,
  recordAttempt,
  setNotificationsMaster,
  updateNotificationSettings,
  writeHeartbeat,
} from '@/data/notifications';
import { StepUpRequiredError } from '@/domain/auth/stepup';
import { ValidationError } from '@/domain/errors';
import { makeEvent, NOTIFY_LIMITS, type EventKind } from '@/domain/notifications';
import { freshAuthForTests } from '../helpers/auth';
import { memoryDb } from '../helpers/db';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const ms = (n: number) => new Date(NOW.getTime() + n);
const fresh = (now: Date = NOW) => freshAuthForTests(1, now);

function dbWithSession() {
  const db = memoryDb();
  db.$client
    .prepare(
      "INSERT INTO sessions (token_hash, created_at, last_seen_at) VALUES ('h', '2026-03-10T11:00:00.000Z', '2026-03-10T11:00:00.000Z')",
    )
    .run();
  return db;
}
const ev = (n: number, kind: EventKind = 'login_success', occurredMs = 0, level?: 50 | 80 | 100) =>
  makeEvent({
    kind,
    dedupeKey: `k${n}`,
    occurredAt: ms(occurredMs).toISOString(),
    level: level ?? null,
  });
const kinds = (db: ReturnType<typeof memoryDb>) => listAuthEvents(db).map((e) => e.kind);
const all = () => true;

describe('the master switch', () => {
  it('is OFF by default, with every category on and severity info', () => {
    const v = getNotificationSettings(memoryDb(), NOW);
    expect(v.master).toBe(false);
    expect(v.effective?.minSeverity).toBe('info');
    expect(Object.values(v.effective?.categories ?? {})).toEqual([true, true, true, true]);
  });

  it('turning ON needs a fresh code, stores consent and the baseline, and is logged', () => {
    const db = dbWithSession();
    expect(() => setNotificationsMaster(db, true, null, NOW)).toThrow(StepUpRequiredError);
    expect(getNotificationSettings(db, NOW).master).toBe(false);
    expect(kinds(db)).toEqual([]);

    setNotificationsMaster(db, true, fresh(), NOW, {}, { 'wm:risk': '5' });
    const v = getNotificationSettings(db, NOW);
    expect(v.master).toBe(true);
    expect(v.consentAt).toBe(NOW.toISOString());
    expect(readAllState(db)).toMatchObject({
      'wm:risk': '5',
      'hb:cycle': NOW.toISOString(),
      'baseline:at': NOW.toISOString(),
    });
    expect(kinds(db)).toEqual(['notifications_on']);
  });

  it('an old code (older than 5 minutes) is refused', () => {
    const db = dbWithSession();
    expect(() =>
      setNotificationsMaster(db, true, freshAuthForTests(1, ms(-6 * 60_000)), NOW),
    ).toThrow(StepUpRequiredError);
  });

  it('turning OFF ALSO needs a fresh code, takes effect at once, records ONE final notice and is logged', () => {
    const db = dbWithSession();
    setNotificationsMaster(db, true, fresh(), NOW);
    expect(() => setNotificationsMaster(db, false, null, NOW)).toThrow(StepUpRequiredError);
    expect(getNotificationSettings(db, NOW).master).toBe(true);

    setNotificationsMaster(db, false, fresh(), NOW);
    expect(getNotificationSettings(db, NOW).master).toBe(false);
    const outbox = loadOutbox(db, NOW);
    expect(outbox.map((i) => i.event.kind)).toEqual(['notifications_switched_off']);
    expect(outbox[0]?.event.severity).toBe('critical');
    expect(kinds(db)).toEqual(['notifications_off', 'notifications_on']);
  });

  it('turning OFF when it is already off records nothing', () => {
    const db = dbWithSession();
    setNotificationsMaster(db, false, fresh(), NOW);
    expect(loadOutbox(db, NOW)).toEqual([]);
    expect(kinds(db)).toEqual([]);
  });

  it('corrupt settings: cannot turn ON; OFF still works and touches only the switch', () => {
    const db = dbWithSession();
    db.$client
      .prepare(
        "INSERT INTO notification_settings (id, master, categories_json, updated_at) VALUES (1, 1, '{\"risk\":true}', 't')",
      )
      .run();
    expect(() => setNotificationsMaster(db, true, fresh(), NOW)).toThrow(ValidationError);
    setNotificationsMaster(db, false, fresh(), NOW);
    const row = db.$client
      .prepare('SELECT master, categories_json FROM notification_settings')
      .get();
    expect(row).toEqual({ master: 0, categories_json: '{"risk":true}' });
    expect(listAuthEvents(db)[0]?.detail).toBe('master_switch_settings_corrupt');
  });

  it('channel changes are logged', () => {
    const db = dbWithSession();
    logChannelChange(db, 'channel_paired', NOW);
    expect(listAuthEvents(db)[0]).toMatchObject({
      kind: 'notifications_settings_changed',
      detail: 'channel_paired',
    });
  });
});

describe('category switches and minimum severity: quieter waits 24 hours', () => {
  const AFTER = ms(24 * 3600_000 + 1000);
  it('louder applies at once with no code; quieter needs a code and waits', () => {
    const db = dbWithSession();
    expect(() =>
      updateNotificationSettings(db, { categories: { analyst: false } }, null, NOW),
    ).toThrow(StepUpRequiredError);
    expect(getNotificationSettings(db, NOW).effective?.categories.analyst).toBe(true);
    updateNotificationSettings(db, { categories: { analyst: false } }, fresh(), NOW);
    expect(getNotificationSettings(db, NOW).effective?.categories.analyst).toBe(true); // still on
    expect(getNotificationSettings(db, ms(24 * 3600_000 - 1)).effective?.categories.analyst).toBe(
      true,
    );
    expect(getNotificationSettings(db, ms(24 * 3600_000)).effective?.categories.analyst).toBe(
      false,
    );
    expect(kinds(db)).toEqual(['notifications_settings_changed']);
  });

  it('asking for the louder value cancels a waiting quieter change', () => {
    const db = dbWithSession();
    updateNotificationSettings(db, { minSeverity: 'critical' }, fresh(), NOW);
    updateNotificationSettings(db, { minSeverity: 'info' }, null, NOW);
    const v = getNotificationSettings(db, AFTER);
    expect(v.effective?.minSeverity).toBe('info');
    expect(v.pending).toEqual({ categories: {} });
  });

  it('a quieter change that matured is NOT lost by a later save or by the master switch', () => {
    const db = dbWithSession();
    updateNotificationSettings(db, { categories: { risk: false } }, fresh(), NOW);
    updateNotificationSettings(db, { minSeverity: 'warning' }, fresh(AFTER), AFTER);
    let v = getNotificationSettings(db, AFTER);
    expect(v.effective?.categories.risk).toBe(false);
    expect(v.effective?.minSeverity).toBe('info'); // the new quieter change is itself waiting
    setNotificationsMaster(db, true, fresh(AFTER), AFTER);
    v = getNotificationSettings(db, AFTER);
    expect(v.effective?.categories.risk).toBe(false);
  });

  it('corrupt stored settings are reported and refuse edits', () => {
    const db = dbWithSession();
    db.$client
      .prepare(
        "INSERT INTO notification_settings (id, master, categories_json, updated_at) VALUES (1, 0, 'junk', 't')",
      )
      .run();
    expect(getNotificationSettings(db, NOW).problem).not.toBeNull();
    expect(() => updateNotificationSettings(db, { minSeverity: 'info' }, null, NOW)).toThrow(
      ValidationError,
    );
  });
});

describe('the outbox', () => {
  it('records an event once (a dedupe key is unique) and reports how many were new', () => {
    const db = memoryDb();
    expect(insertEvents(db, [ev(1), ev(2)], NOW)).toBe(2);
    expect(insertEvents(db, [ev(1), ev(3)], NOW)).toBe(1);
    expect(loadOutbox(db, NOW)).toHaveLength(3);
  });

  it('keeps an event that failed, and hides one that was sent or is too old', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1), ev(2), ev(3, 'login_success', -NOTIFY_LIMITS.maxAgeMs - 1000)], NOW);
    recordAttempt(db, {
      eventId: 1,
      channel: 'fake',
      status: 'failed',
      at: NOW,
      errorCode: 'timeout',
    });
    recordAttempt(db, { eventId: 2, channel: 'fake', status: 'sent', at: NOW });
    expect(loadOutbox(db, NOW).map((i) => i.id)).toEqual([1]);
  });

  it('claimDue claims what is due once: a second claim (the other process) gets nothing', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1), ev(2)], NOW);
    const first = claimDue(db, NOW, 'fake', all);
    expect(first.claimed.map((c) => c.eventId)).toEqual([1, 2]);
    const second = claimDue(db, ms(1000), 'fake', all);
    expect(second.claimed).toEqual([]); // both are in flight
  });

  it('a claim that was never finished is claimed again after the stale time (at-least-once)', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1)], NOW);
    claimDue(db, NOW, 'fake', all);
    const later = ms(NOTIFY_LIMITS.staleSendingMs + 61_000); // stale + the 1-minute backoff
    expect(claimDue(db, later, 'fake', all).claimed.map((c) => c.eventId)).toEqual([1]);
  });

  it('respects the filter (settings and the final-notice rule)', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1), ev(2, 'notifications_switched_off')], NOW);
    const c = claimDue(db, NOW, 'fake', (e) => e.kind === 'notifications_switched_off');
    expect(c.claimed.map((x) => x.event.kind)).toEqual(['notifications_switched_off']);
  });

  it('holds the rest above 20 an hour, makes ONE summary, and keeps the held events', () => {
    const db = memoryDb();
    insertEvents(
      db,
      Array.from({ length: 25 }, (_, i) => ev(i + 1, 'login_success', i)),
      NOW,
    );
    const c = claimDue(db, NOW, 'fake', all);
    const real = c.claimed.filter((x) => x.event.kind !== 'flood_summary');
    const summary = c.claimed.filter((x) => x.event.kind === 'flood_summary');
    expect(real).toHaveLength(20);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.event.count).toBe(5);
    expect(c.held).toBe(5);
    for (const x of c.claimed)
      recordAttempt(db, { eventId: x.eventId, channel: 'fake', status: 'sent', at: NOW });
    // a minute later: still over the ceiling, and NO second summary this hour
    const again = claimDue(db, ms(60_000), 'fake', all);
    expect(again.claimed).toEqual([]);
    expect(loadOutbox(db, ms(60_000))).toHaveLength(5);
    // an hour later the held events go out
    const later = claimDue(db, ms(3600_000 + 60_000), 'fake', all);
    expect(later.claimed.filter((x) => x.event.kind === 'login_success')).toHaveLength(5);
  });

  it('critical events use the reserve when the normal quota is gone', () => {
    const db = memoryDb();
    insertEvents(
      db,
      Array.from({ length: 20 }, (_, i) => ev(i + 1, 'login_success', i)),
      NOW,
    );
    for (const x of claimDue(db, NOW, 'fake', all).claimed)
      recordAttempt(db, { eventId: x.eventId, channel: 'fake', status: 'sent', at: NOW });
    insertEvents(
      db,
      [ev(100, 'login_success', 100), ev(101, 'halt_started_daily_loss', 101)],
      ms(1000),
    );
    const c = claimDue(db, ms(1000), 'fake', all);
    expect(c.claimed.map((x) => x.event.kind)).toContain('halt_started_daily_loss');
    expect(c.claimed.map((x) => x.event.kind)).not.toContain('login_success');
  });

  it('nothing is lost by a restart: the state is all in the database', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1)], NOW);
    claimDue(db, NOW, 'fake', all);
    recordAttempt(db, {
      eventId: 1,
      channel: 'fake',
      status: 'failed',
      at: NOW,
      errorCode: 'network',
    });
    const copy = new (db.$client.constructor as new (b: Buffer) => typeof db.$client)(
      db.$client.serialize(),
    );
    const row = copy
      .prepare('SELECT status, error_code FROM notification_deliveries ORDER BY id DESC')
      .get();
    expect(row).toEqual({ status: 'failed', error_code: 'network' });
  });
});

describe('display and health', () => {
  it('derives a status per event, newest first', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1), ev(2), ev(3)], NOW);
    recordAttempt(db, { eventId: 1, channel: 'fake', status: 'sent', at: NOW });
    recordAttempt(db, {
      eventId: 2,
      channel: 'fake',
      status: 'failed',
      at: NOW,
      errorCode: 'forbidden',
    });
    const rows = listRecentEvents(db, ms(1000));
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [3, 'due'],
      [2, 'waiting'],
      [1, 'sent'],
    ]);
    expect(rows[1]).toMatchObject({ failures: 1, lastErrorCode: 'forbidden' });
  });
  it('marks events that the settings hold back', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1)], NOW);
    expect(listRecentEvents(db, NOW, 10, () => false)[0]?.status).toBe('held_by_settings');
  });
  it('health input: latest attempts and how long an event has been failing', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1, 'login_success', -20 * 60_000)], NOW);
    for (let i = 0; i < 3; i++)
      recordAttempt(db, {
        eventId: 1,
        channel: 'fake',
        status: 'failed',
        at: ms(-i),
        errorCode: 'timeout',
      });
    const h = getHealthInput(db, NOW);
    expect(h.recentStatuses).toEqual(['failed', 'failed', 'failed']);
    expect(h.oldestFailingAgeMs).toBe(20 * 60_000);
  });
  it('currentMaxIds is zero on an empty database', () => {
    expect(currentMaxIds(memoryDb())).toEqual({ risk: 0, verdict: 0, auth: 0, usage: 0 });
  });
});

describe('switching ON when already ON changes nothing (no events are skipped)', () => {
  it('keeps the watermarks, the consent time and the log', () => {
    const db = dbWithSession();
    setNotificationsMaster(db, true, fresh(), NOW, {}, { 'wm:risk': '5' });
    const before = JSON.stringify([
      readAllState(db),
      getNotificationSettings(db, NOW).consentAt,
      listAuthEvents(db).length,
    ]);
    setNotificationsMaster(db, true, fresh(ms(60_000)), ms(60_000), {}, { 'wm:risk': '999' });
    expect(
      JSON.stringify([
        readAllState(db),
        getNotificationSettings(db, NOW).consentAt,
        listAuthEvents(db).length,
      ]),
    ).toBe(before);
  });
});

describe('health', () => {
  const enable = (db: ReturnType<typeof memoryDb>) =>
    setNotificationsMaster(db, true, fresh(), NOW);
  it('the latest RESULTS are looked at, not the claim rows (so three failed deliveries in a row show)', () => {
    const db = dbWithSession();
    insertEvents(db, [ev(1)], NOW);
    for (let i = 0; i < 3; i++) {
      recordAttempt(db, { eventId: 1, channel: 'fake', status: 'sending', at: ms(i * 10) });
      recordAttempt(db, {
        eventId: 1,
        channel: 'fake',
        status: 'failed',
        at: ms(i * 10 + 1),
        errorCode: 'network',
      });
    }
    expect(getHealthInput(db, ms(1000)).recentStatuses).toEqual(['failed', 'failed', 'failed']);
  });
  it('loadHealth reports the heartbeat, settings problems and expired-unsent events', () => {
    const db = dbWithSession();
    enable(db);
    const h = loadHealth(db, ms(30_000), true);
    expect(h?.input).toMatchObject({
      masterOn: true,
      channelReady: true,
      heartbeatAgeMs: 30_000,
      settingsProblem: false,
      expiredUnsent: 0,
      collectorProblems: 0,
    });
    writeHeartbeat(db, ms(40_000), ['analyst_settings']);
    expect(loadHealth(db, ms(50_000), true)?.input).toMatchObject({
      heartbeatAgeMs: 10_000,
      collectorProblems: 1,
    });
    db.$client.prepare("UPDATE notification_settings SET categories_json = 'junk'").run();
    expect(loadHealth(db, ms(50_000), true)?.input.settingsProblem).toBe(true);
  });
  it('an event that expired without being sent is counted for 7 days, then forgotten; a sent one is not', () => {
    const db = dbWithSession();
    enable(db);
    const day = 24 * 3600_000;
    insertEvents(
      db,
      [
        ev(1, 'login_success', -2 * day),
        ev(2, 'login_success', -3 * day),
        ev(3, 'login_success', -8 * day),
        ev(4, 'login_success', -1000),
      ],
      NOW,
    );
    recordAttempt(db, { eventId: 2, channel: 'fake', status: 'sent', at: ms(-2 * day) });
    expect(loadHealth(db, NOW, true)?.input.expiredUnsent).toBe(1); // event 1 only
    expect(countExpiredUnsent(db, NOW, () => false)).toBe(0); // switched off by the settings: not a failure
  });
  it('loadHealth never throws: a broken database gives null (the caller shows "status unknown")', () => {
    const db = dbWithSession();
    enable(db);
    db.$client.exec('DROP TABLE notification_deliveries; DROP TABLE notification_state');
    expect(loadHealth(db, NOW, true)).toBeNull();
  });
  it('the heartbeat is written at switch-on (a grace period) and by every cycle', () => {
    const db = dbWithSession();
    enable(db);
    expect(readAllState(db)['hb:cycle']).toBe(NOW.toISOString());
    writeHeartbeat(db, ms(5000), []);
    expect(readAllState(db)['hb:cycle']).toBe(ms(5000).toISOString());
    expect(readAllState(db)['last:problems']).toBe('[]');
  });
  it('findEventByKey finds exactly one event', () => {
    const db = memoryDb();
    insertEvents(db, [ev(1), ev(2)], NOW);
    expect(findEventByKey(db, 'k2')?.id).toBe(2);
    expect(findEventByKey(db, 'nope')).toBeUndefined();
  });
});

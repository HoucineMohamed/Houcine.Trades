import { describe, expect, it } from 'vitest';
import { makeEvent, severityOf } from './events';
import type { EventKind } from './kinds';
import {
  alertHealth,
  alertProblems,
  backoffMs,
  HEARTBEAT_MAX_AGE_MS,
  type HealthInput,
  itemStatus,
  NOTIFY_LIMITS,
  planBatch,
  type AttemptRecord,
  type OutboxItem,
} from './policy';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const item = (
  id: number,
  kind: EventKind = 'login_success',
  attempts: AttemptRecord[] = [],
  occurredMs = 0,
  level?: 50 | 80 | 100,
): OutboxItem => ({
  id,
  event: makeEvent({ kind, dedupeKey: `k${id}`, occurredAt: at(occurredMs), level: level ?? null }),
  attempts,
});
const failed = (ms: number, retryAfterS: number | null = null): AttemptRecord => ({
  status: 'failed',
  at: at(ms),
  retryAfterS,
});
const MIN = 60_000;

describe('backoff', () => {
  it('doubles from one minute and is capped at 30 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoffMs)).toEqual([
      MIN,
      2 * MIN,
      4 * MIN,
      8 * MIN,
      16 * MIN,
      30 * MIN,
      30 * MIN,
      30 * MIN,
    ]);
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
    expect(backoffMs(1.5)).toBe(0);
  });
});

describe('itemStatus (derived from the attempt log)', () => {
  const now = (ms: number) => new Date(T0.getTime() + ms);
  it('a new event is due at once', () => {
    expect(itemStatus(item(1), T0)).toEqual({ status: 'due', nextAt: null, failures: 0 });
  });
  it('a sent event is done, whatever else happened', () => {
    const sent: AttemptRecord = { status: 'sent', at: at(10), retryAfterS: null };
    expect(itemStatus(item(1, 'login_success', [failed(0), sent]), now(1000)).status).toBe('sent');
  });
  it('after a failure it waits for the backoff, then is due again', () => {
    const it1 = item(1, 'login_success', [failed(0)]);
    expect(itemStatus(it1, now(MIN - 1))).toMatchObject({ status: 'waiting', failures: 1 });
    expect(itemStatus(it1, now(MIN))).toMatchObject({ status: 'due', failures: 1 });
  });
  it('the wait grows with each failure', () => {
    const it2 = item(1, 'login_success', [failed(0), failed(MIN)]);
    expect(itemStatus(it2, now(MIN + 2 * MIN - 1)).status).toBe('waiting');
    expect(itemStatus(it2, now(MIN + 2 * MIN)).status).toBe('due');
  });
  it('a retry-after from the channel can lengthen the wait but never shorten it', () => {
    const long = item(1, 'login_success', [failed(0, 300)]);
    expect(itemStatus(long, now(299_000)).status).toBe('waiting');
    expect(itemStatus(long, now(300_000)).status).toBe('due');
    const short = item(2, 'login_success', [failed(0, 5)]);
    expect(itemStatus(short, now(10_000)).status).toBe('waiting'); // still the 1-minute backoff
  });
  it('an attempt still "sending" is in flight, then counts as failed once stale', () => {
    const sending: AttemptRecord = { status: 'sending', at: at(0), retryAfterS: null };
    expect(
      itemStatus(item(1, 'login_success', [sending]), now(NOTIFY_LIMITS.staleSendingMs - 1)).status,
    ).toBe('in_flight');
    const stale = itemStatus(
      item(1, 'login_success', [sending]),
      now(NOTIFY_LIMITS.staleSendingMs + MIN),
    );
    expect(stale).toMatchObject({ status: 'due', failures: 1 }); // at-least-once: it will be sent again
  });
  it('an event older than 24 hours that was never sent is expired (never sent, still recorded)', () => {
    const old = item(1, 'login_success', [failed(0)], -NOTIFY_LIMITS.maxAgeMs - 1);
    expect(itemStatus(old, T0).status).toBe('expired');
    const edge = item(2, 'login_success', [], -NOTIFY_LIMITS.maxAgeMs);
    expect(itemStatus(edge, T0).status).toBe('due'); // exactly at the age is still allowed
  });
});

describe('itemStatus: a claim and its result are one attempt', () => {
  const sending = (ms: number): AttemptRecord => ({
    status: 'sending',
    at: at(ms),
    retryAfterS: null,
  });
  const now = (ms: number) => new Date(T0.getTime() + ms);
  it('"sending" followed by "failed" is ONE failure, not an attempt still in flight', () => {
    const i = item(1, 'login_success', [sending(0), failed(100)]);
    expect(itemStatus(i, now(MIN + 100))).toMatchObject({ status: 'due', failures: 1 });
    expect(itemStatus(i, now(1000)).status).toBe('waiting');
  });
  it('"sending" followed by "sent" is done', () => {
    const sent: AttemptRecord = { status: 'sent', at: at(100), retryAfterS: null };
    expect(itemStatus(item(1, 'login_success', [sending(0), sent]), now(200)).status).toBe('sent');
  });
  it('a claim that never got a result and was claimed AGAIN counts as a failure', () => {
    const i = item(1, 'login_success', [sending(0), sending(10 * MIN), failed(10 * MIN + 50)]);
    expect(itemStatus(i, now(11 * MIN)).failures).toBe(2);
  });
  it('the retry-after belongs to the failure it came with', () => {
    const i = item(1, 'login_success', [sending(0), failed(100, 300)]);
    expect(itemStatus(i, now(250_000)).status).toBe('waiting');
    expect(itemStatus(i, now(300_100)).status).toBe('due');
  });
});

describe('planBatch (flood ceiling, summary, critical quota)', () => {
  const normals = (n: number) =>
    Array.from({ length: n }, (_, i) => item(100 + i, 'login_success', [], i));
  const sent = (n: number, kind: EventKind = 'login_success') =>
    Array.from({ length: n }, () => ({ kind, severity: severityOf(kind, null) }));

  it('sends everything while under the ceiling', () => {
    const p = planBatch({ due: normals(5), sentLastHour: [], summarySentLastHour: false });
    expect(p.send).toHaveLength(5);
    expect(p.held).toEqual([]);
    expect(p.summaryCount).toBeNull();
  });
  it('holds the rest above 20 per hour and asks for ONE summary', () => {
    const p = planBatch({ due: normals(25), sentLastHour: [], summarySentLastHour: false });
    expect(p.send).toHaveLength(20);
    expect(p.held).toHaveLength(5);
    expect(p.summaryCount).toBe(5);
  });
  it('already-sent messages in the last hour use up the quota', () => {
    const p = planBatch({ due: normals(5), sentLastHour: sent(18), summarySentLastHour: true });
    expect(p.send).toHaveLength(2);
    expect(p.held).toHaveLength(3);
    expect(p.summaryCount).toBeNull(); // a summary already went out this hour
  });
  it('critical events may use the reserved 10 extra, and then they are held too', () => {
    const crit = (n: number) =>
      Array.from({ length: n }, (_, i) => item(200 + i, 'halt_started_daily_loss', [], i));
    const p = planBatch({ due: crit(15), sentLastHour: sent(20), summarySentLastHour: false });
    expect(p.send).toHaveLength(10);
    expect(p.held).toHaveLength(5);
    const none = planBatch({ due: normals(3), sentLastHour: sent(20), summarySentLastHour: false });
    expect(none.send).toEqual([]); // normal events cannot use the reserve
  });
  it('the total can never pass 30 per hour', () => {
    const due = [
      ...normals(40),
      ...Array.from({ length: 40 }, (_, i) => item(300 + i, 'recovery_code_used')),
    ];
    expect(planBatch({ due, sentLastHour: [], summarySentLastHour: false }).send.length).toBe(30);
  });
  it('critical events go first', () => {
    const due = [item(1, 'login_success', [], 0), item(2, 'recovery_code_used', [], 5000)];
    expect(
      planBatch({ due, sentLastHour: [], summarySentLastHour: false }).send.map((i) => i.id),
    ).toEqual([2, 1]);
  });
  it('the summary and the test message do not count against the ceiling', () => {
    const due = [item(1, 'flood_summary'), item(2, 'test_message')];
    expect(
      planBatch({ due, sentLastHour: sent(30), summarySentLastHour: false }).send,
    ).toHaveLength(2);
    const p = planBatch({
      due: normals(1),
      sentLastHour: sent(20, 'login_success').concat(sent(50, 'flood_summary')),
      summarySentLastHour: true,
    });
    expect(p.send).toEqual([]);
  });
  it('usage events at level 100 are critical and use the reserve', () => {
    const due = [item(1, 'daily_loss_usage', [], 0, 100)];
    expect(
      planBatch({ due, sentLastHour: sent(25), summarySentLastHour: false }).send,
    ).toHaveLength(1);
  });
});

describe('alertHealth / alertProblems', () => {
  const base: HealthInput = {
    masterOn: true,
    channelReady: true,
    recentStatuses: [],
    oldestFailingAgeMs: null,
    heartbeatAgeMs: 10_000,
    settingsProblem: false,
    expiredUnsent: 0,
    collectorProblems: 0,
  };
  it('is off when the switch is off, whatever else is wrong', () => {
    const all = {
      ...base,
      masterOn: false,
      channelReady: false,
      settingsProblem: true,
      expiredUnsent: 3,
      heartbeatAgeMs: null,
    };
    expect(alertHealth(all)).toBe('off');
    expect(alertProblems(all)).toEqual([]);
  });
  it('is ok when nothing is wrong', () => {
    expect(alertHealth(base)).toBe('ok');
    expect(alertProblems({ ...base, recentStatuses: ['sent', 'failed', 'failed'] })).toEqual([]);
  });
  it('each problem has its own code', () => {
    expect(alertProblems({ ...base, channelReady: false })).toEqual(['channel']);
    expect(alertProblems({ ...base, settingsProblem: true })).toEqual(['settings']);
    expect(alertProblems({ ...base, recentStatuses: ['failed', 'failed', 'failed'] })).toEqual([
      'delivery',
    ]);
    expect(alertProblems({ ...base, oldestFailingAgeMs: NOTIFY_LIMITS.failingAfterMs })).toEqual([
      'delivery',
    ]);
    expect(alertProblems({ ...base, expiredUnsent: 1 })).toEqual(['expired']);
    expect(alertProblems({ ...base, collectorProblems: 2 })).toEqual(['collector']);
  });
  it('a failing delivery is below the threshold until 15 minutes / 3 results in a row', () => {
    expect(
      alertProblems({ ...base, oldestFailingAgeMs: NOTIFY_LIMITS.failingAfterMs - 1 }),
    ).toEqual([]);
    expect(alertProblems({ ...base, recentStatuses: ['failed', 'failed'] })).toEqual([]);
  });
  it('a worker that never ran, or has not run for 3 cycles, is a problem (events are not being collected)', () => {
    expect(alertProblems({ ...base, heartbeatAgeMs: null })).toEqual(['worker']);
    expect(alertProblems({ ...base, heartbeatAgeMs: HEARTBEAT_MAX_AGE_MS })).toEqual([]);
    expect(alertProblems({ ...base, heartbeatAgeMs: HEARTBEAT_MAX_AGE_MS + 1 })).toEqual([
      'worker',
    ]);
    expect(HEARTBEAT_MAX_AGE_MS).toBe(3 * NOTIFY_LIMITS.workerIntervalMs);
  });
  it('several problems are all reported, and any of them is "failing"', () => {
    const all = { ...base, channelReady: false, expiredUnsent: 2, heartbeatAgeMs: null };
    expect(alertProblems(all)).toEqual(['channel', 'worker', 'expired']);
    expect(alertHealth(all)).toBe('failing');
  });
});

describe('itemStatus: exact boundaries and unreadable data', () => {
  const sending = (ms: number): AttemptRecord => ({
    status: 'sending',
    at: at(ms),
    retryAfterS: null,
  });
  const now = (ms: number) => new Date(T0.getTime() + ms);
  it('a claim becomes stale at EXACTLY the stale time', () => {
    const i = item(1, 'login_success', [sending(0)]);
    expect(itemStatus(i, now(NOTIFY_LIMITS.staleSendingMs - 1)).status).toBe('in_flight');
    expect(itemStatus(i, now(NOTIFY_LIMITS.staleSendingMs)).failures).toBe(1);
  });
  it('the stale window is longer than a full batch of slow sends', () => {
    expect(NOTIFY_LIMITS.staleSendingMs).toBeGreaterThanOrEqual(10 * MIN);
  });
  it('the backoff after the 3rd and later failures is exact, and capped', () => {
    const f3 = item(1, 'login_success', [failed(0), failed(1000), failed(2000)]);
    expect(itemStatus(f3, now(2000 + 4 * MIN - 1)).status).toBe('waiting');
    expect(itemStatus(f3, now(2000 + 4 * MIN))).toMatchObject({
      status: 'due',
      nextAt: at(2000 + 4 * MIN),
    });
    const f7 = item(
      1,
      'login_success',
      Array.from({ length: 7 }, (_, i) => failed(i * 1000)),
    );
    expect(itemStatus(f7, now(6000 + 30 * MIN - 1)).status).toBe('waiting');
    expect(itemStatus(f7, now(6000 + 30 * MIN)).status).toBe('due');
  });
  it('expired beats in flight, due and waiting, but SENT beats expired', () => {
    const old = -NOTIFY_LIMITS.maxAgeMs - 1000;
    expect(itemStatus(item(1, 'login_success', [sending(0)], old), T0).status).toBe('expired');
    expect(itemStatus(item(2, 'login_success', [failed(0)], old), T0).status).toBe('expired');
    const sent: AttemptRecord = { status: 'sent', at: at(0), retryAfterS: null };
    expect(itemStatus(item(3, 'login_success', [sent], old), T0).status).toBe('sent');
  });
  it('several unresolved claims are several failures', () => {
    const i = item(1, 'login_success', [sending(0), sending(MIN), sending(2 * MIN)]);
    expect(itemStatus(i, now(2 * MIN + NOTIFY_LIMITS.staleSendingMs))).toMatchObject({
      failures: 3,
      status: 'due',
    });
  });
  it('a retry-after belongs to its own failure only, and equal to the backoff changes nothing', () => {
    const i = item(1, 'login_success', [
      sending(0),
      failed(100, 300),
      sending(400_000),
      failed(400_100),
    ]);
    expect(itemStatus(i, now(400_100 + 2 * MIN - 1)).status).toBe('waiting'); // second backoff, no carry-over
    expect(itemStatus(i, now(400_100 + 2 * MIN)).status).toBe('due');
    const eq = item(2, 'login_success', [failed(0, 60)]);
    expect(itemStatus(eq, now(60_000)).status).toBe('due');
  });
  it('a result row with the same time as its claim still pairs, in either listing order', () => {
    const a = item(1, 'login_success', [sending(0), failed(0)]);
    const b = item(1, 'login_success', [failed(0), sending(0)]);
    expect(itemStatus(a, now(1000)).failures).toBe(1);
    expect(itemStatus(a, now(1000)).status).toBe('waiting');
    expect(itemStatus(b, now(MIN + 1000)).status).not.toBe('sent'); // (this order is not produced by the data layer)
  });
  it('an unreadable attempt time or a huge retry-after never throws and never waits longer than the cap', () => {
    const garbage = item(1, 'login_success', [
      { status: 'failed', at: 'garbage', retryAfterS: null },
    ]);
    expect(() => itemStatus(garbage, T0)).not.toThrow();
    expect(itemStatus(garbage, T0).status).toBe('waiting');
    for (const retryAfterS of [1e13, Infinity, Number.NaN, -5]) {
      const i = item(2, 'login_success', [failed(0, retryAfterS)]);
      const st = itemStatus(i, now(NOTIFY_LIMITS.backoffCapMs));
      expect(['waiting', 'due']).toContain(st.status);
      if (retryAfterS > 0) expect(st.status).toBe('due'); // capped at 30 minutes, not 1e13 seconds
    }
  });
  it('an event whose own time cannot be read is shown as expired and never sent', () => {
    const bad = { ...item(1), event: { ...item(1).event, occurredAt: 'not a time' } };
    expect(itemStatus(bad, T0).status).toBe('expired');
  });
});

describe('planBatch: exact ceilings and ordering', () => {
  const sent = (n: number, kind: EventKind = 'login_success') =>
    Array.from({ length: n }, () => ({ kind, severity: severityOf(kind, null) }));
  const plan = (due: OutboxItem[], used: number) =>
    planBatch({ due, sentLastHour: sent(used), summarySentLastHour: true });
  it('the normal ceiling: 19 used lets one more through, 20 holds it', () => {
    expect(plan([item(1)], 19).send).toHaveLength(1);
    expect(plan([item(1)], 20).send).toHaveLength(0);
  });
  it('the critical ceiling: 29 used lets one through, 30 holds it', () => {
    expect(plan([item(1, 'recovery_code_used')], 29).send).toHaveLength(1);
    expect(plan([item(1, 'recovery_code_used')], 30).send).toHaveLength(0);
  });
  it('same time, same severity: lower id first, whatever the input order', () => {
    const due = [
      item(5, 'recovery_code_used'),
      item(2, 'recovery_code_used'),
      item(9, 'recovery_code_used'),
    ];
    expect(plan(due, 0).send.map((i) => i.id)).toEqual([2, 5, 9]);
    expect(plan([...due].reverse(), 0).send.map((i) => i.id)).toEqual([2, 5, 9]);
  });
  it('a summary needs held events AND no summary this hour; held criticals count', () => {
    expect(
      planBatch({ due: [], sentLastHour: [], summarySentLastHour: false }).summaryCount,
    ).toBeNull();
    const held = [item(1, 'recovery_code_used')];
    expect(
      planBatch({ due: held, sentLastHour: sent(30), summarySentLastHour: false }).summaryCount,
    ).toBe(1);
  });
  it('the critical events share the hourly counter (15 critical + 20 normal send 30, not 35)', () => {
    const due = [
      ...Array.from({ length: 15 }, (_, i) => item(100 + i, 'recovery_code_used', [], i)),
      ...Array.from({ length: 20 }, (_, i) => item(200 + i, 'login_success', [], i)),
    ];
    const p = plan(due, 0);
    expect(p.send).toHaveLength(30);
    expect(p.send.filter((i) => i.event.severity === 'critical')).toHaveLength(15);
    expect(p.send.filter((i) => i.event.severity !== 'critical')).toHaveLength(15);
  });
});

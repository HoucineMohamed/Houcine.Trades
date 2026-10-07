import { describe, expect, it } from 'vitest';
import { makeEvent } from './events';
import type { EventKind } from './kinds';
import {
  alertHealth,
  backoffMs,
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
    Array.from({ length: n }, () => ({ kind }));

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

describe('alertHealth', () => {
  const base = {
    masterOn: true,
    channelReady: true,
    recentStatuses: [] as const,
    oldestFailingAgeMs: null,
  };
  it('is off when the switch is off, whatever else is wrong', () => {
    expect(alertHealth({ ...base, masterOn: false, channelReady: false })).toBe('off');
  });
  it('is ok when nothing fails', () => {
    expect(alertHealth(base)).toBe('ok');
    expect(alertHealth({ ...base, recentStatuses: ['sent', 'failed', 'failed'] })).toBe('ok');
  });
  it('is failing when the channel is not configured, 3 attempts in a row failed, or an event has failed for 15 minutes', () => {
    expect(alertHealth({ ...base, channelReady: false })).toBe('failing');
    expect(alertHealth({ ...base, recentStatuses: ['failed', 'failed', 'failed'] })).toBe(
      'failing',
    );
    expect(alertHealth({ ...base, oldestFailingAgeMs: NOTIFY_LIMITS.failingAfterMs })).toBe(
      'failing',
    );
    expect(alertHealth({ ...base, oldestFailingAgeMs: NOTIFY_LIMITS.failingAfterMs - 1 })).toBe(
      'ok',
    );
  });
});

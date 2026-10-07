import { FILTER_EXEMPT_KINDS, QUOTA_EXEMPT_KINDS, type NotificationEvent } from './events';
import type { DeliveryStatus } from './kinds';

/**
 * The outbox rules. An event is RECORDED first and delivered later; a failed delivery is retried
 * with a capped backoff until the event is too old. Every number here lives in code, not in
 * settings, so nothing can raise a ceiling from the web.
 */

export const NOTIFY_LIMITS = {
  /** Messages per hour (flood ceiling). */
  perHour: 20,
  /** Extra messages per hour that only CRITICAL events may use. Total never above perHour + this. */
  criticalReservePerHour: 10,
  /** An undelivered event older than this is marked expired: never sent, still shown on the page. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  backoffMs: [60_000, 120_000, 240_000, 480_000, 960_000],
  backoffCapMs: 30 * 60_000,
  /** A "sending" attempt with no result after this long counts as failed (the process died). */
  staleSendingMs: 2 * 60_000,
  workerIntervalMs: 30_000,
  /** Alerts count as "failing" once an event has failed to deliver for this long. */
  failingAfterMs: 15 * 60_000,
} as const;

export const HOUR_MS = 60 * 60 * 1000;

/** Wait before the next try, after `failures` failed tries (1 = first failure). */
export function backoffMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < 1) return 0;
  return NOTIFY_LIMITS.backoffMs[failures - 1] ?? NOTIFY_LIMITS.backoffCapMs;
}

export interface AttemptRecord {
  status: DeliveryStatus;
  at: string;
  retryAfterS: number | null;
}
export interface OutboxItem {
  id: number;
  event: NotificationEvent;
  attempts: AttemptRecord[];
}

export type ItemStatus = 'sent' | 'expired' | 'in_flight' | 'waiting' | 'due';

/** The state of an event, DERIVED from its attempts (the attempt log is append-only). */
export function itemStatus(
  item: OutboxItem,
  now: Date,
): { status: ItemStatus; nextAt: string | null; failures: number } {
  const t = now.getTime();
  if (item.attempts.some((a) => a.status === 'sent'))
    return { status: 'sent', nextAt: null, failures: 0 };
  const sorted = [...item.attempts].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  let failures = 0;
  let lastFailedMs: number | null = null;
  let retryAfter = 0;
  // A 'sending' row is the claim; a later 'sent' / 'failed' row is its result and closes it.
  let open: AttemptRecord | null = null;
  const fail = (atMs: number, retryAfterS: number | null) => {
    failures += 1;
    lastFailedMs = atMs;
    retryAfter = retryAfterS ? retryAfterS * 1000 : 0;
  };
  for (const a of sorted) {
    if (a.status === 'sending') {
      if (open) fail(Date.parse(open.at), null); // a claim that never got a result
      open = a;
    } else {
      open = null;
      if (a.status === 'failed') fail(Date.parse(a.at), a.retryAfterS);
    }
  }
  let inFlight = false;
  if (open) {
    if (t - Date.parse(open.at) >= NOTIFY_LIMITS.staleSendingMs) fail(Date.parse(open.at), null);
    else inFlight = true;
  }
  const age = t - Date.parse(item.event.occurredAt);
  if (age > NOTIFY_LIMITS.maxAgeMs) return { status: 'expired', nextAt: null, failures };
  if (inFlight) return { status: 'in_flight', nextAt: null, failures };
  if (lastFailedMs === null) return { status: 'due', nextAt: null, failures: 0 };
  const nextMs = lastFailedMs + Math.max(backoffMs(failures), retryAfter);
  return {
    status: nextMs <= t ? 'due' : 'waiting',
    nextAt: new Date(nextMs).toISOString(),
    failures,
  };
}

export interface SentRecord {
  kind: NotificationEvent['kind'];
}

export interface BatchPlan {
  send: OutboxItem[];
  /** Due but held back by the hourly ceiling: they stay in the outbox. */
  held: OutboxItem[];
  /** Set when events were held and no summary went out in the last hour. */
  summaryCount: number | null;
}

/**
 * Which due events go out now? Normal events may use the hourly quota; CRITICAL events may also use
 * the reserved extra quota; the summary and the test message do not count. Critical events go first.
 */
export function planBatch(input: {
  due: readonly OutboxItem[];
  sentLastHour: readonly SentRecord[];
  summarySentLastHour: boolean;
}): BatchPlan {
  let used = input.sentLastHour.filter((s) => !QUOTA_EXEMPT_KINDS.includes(s.kind)).length;
  const sorted = [...input.due].sort((a, b) => {
    const ca = a.event.severity === 'critical' ? 0 : 1;
    const cb = b.event.severity === 'critical' ? 0 : 1;
    return (
      ca - cb || Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt) || a.id - b.id
    );
  });
  const send: OutboxItem[] = [];
  const held: OutboxItem[] = [];
  for (const item of sorted) {
    if (QUOTA_EXEMPT_KINDS.includes(item.event.kind)) {
      send.push(item);
      continue;
    }
    const critical = item.event.severity === 'critical';
    const ceiling = NOTIFY_LIMITS.perHour + (critical ? NOTIFY_LIMITS.criticalReservePerHour : 0);
    if (used < ceiling) {
      used += 1;
      send.push(item);
    } else held.push(item);
  }
  return {
    send,
    held,
    summaryCount: held.length > 0 && !input.summarySentLastHour ? held.length : null,
  };
}

export { FILTER_EXEMPT_KINDS };

export type AlertHealth = 'off' | 'ok' | 'failing';

/** Shown in the header only when alerts are switched ON and not getting through. Never blocks. */
export function alertHealth(input: {
  masterOn: boolean;
  channelReady: boolean;
  /** Status of the latest attempts, newest first (at most 3 are looked at). */
  recentStatuses: readonly DeliveryStatus[];
  /** How long the oldest event with a failed delivery has been waiting, or null. */
  oldestFailingAgeMs: number | null;
}): AlertHealth {
  if (!input.masterOn) return 'off';
  if (!input.channelReady) return 'failing';
  const recent = input.recentStatuses.slice(0, 3);
  if (recent.length === 3 && recent.every((s) => s === 'failed')) return 'failing';
  if (input.oldestFailingAgeMs !== null && input.oldestFailingAgeMs >= NOTIFY_LIMITS.failingAfterMs)
    return 'failing';
  return 'ok';
}

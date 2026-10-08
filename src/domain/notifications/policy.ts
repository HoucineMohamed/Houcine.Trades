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
  /** A "sending" attempt with no result after this long counts as failed (the process died). Longer than any batch. */
  staleSendingMs: 10 * 60_000,
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
  // A time that cannot be read is treated as "now": it can only delay a retry, never throw or loop.
  const when = (iso: string): number => {
    const v = Date.parse(iso);
    return Number.isFinite(v) ? v : t;
  };
  const sorted = [...item.attempts].sort((x, y) => when(x.at) - when(y.at));
  let failures = 0;
  let lastFailedMs: number | null = null;
  let retryAfter = 0;
  // A 'sending' row is the claim; a later 'sent' / 'failed' row is its result and closes it.
  let open: AttemptRecord | null = null;
  const fail = (atMs: number, retryAfterS: number | null) => {
    failures += 1;
    lastFailedMs = atMs;
    // never wait longer than the cap, whatever the channel asked for (a huge value must not push a retry past expiry)
    retryAfter =
      typeof retryAfterS === 'number' && Number.isFinite(retryAfterS) && retryAfterS > 0
        ? Math.min(retryAfterS * 1000, NOTIFY_LIMITS.backoffCapMs)
        : 0;
  };
  for (const a of sorted) {
    if (a.status === 'sending') {
      if (open) fail(when(open.at), null); // a claim that never got a result
      open = a;
    } else {
      open = null;
      if (a.status === 'failed') fail(when(a.at), a.retryAfterS);
    }
  }
  let inFlight = false;
  if (open) {
    if (t - when(open.at) >= NOTIFY_LIMITS.staleSendingMs) fail(when(open.at), null);
    else inFlight = true;
  }
  const occurred = Date.parse(item.event.occurredAt);
  // an event whose own time cannot be read can never be aged correctly: it is shown as expired, never sent
  if (!Number.isFinite(occurred) || t - occurred > NOTIFY_LIMITS.maxAgeMs) {
    return { status: 'expired', nextAt: null, failures };
  }
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
  severity: NotificationEvent['severity'];
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
  // Two counters: ALL counted messages (never above perHour + reserve) and the NON-critical ones
  // (never above perHour). So critical events have a reserve of their own and cannot starve the rest.
  const counted = input.sentLastHour.filter((x) => !QUOTA_EXEMPT_KINDS.includes(x.kind));
  let total = counted.length;
  let normal = counted.filter((x) => x.severity !== 'critical').length;
  const totalCeiling = NOTIFY_LIMITS.perHour + NOTIFY_LIMITS.criticalReservePerHour;
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
    const allowed = critical
      ? total < totalCeiling
      : normal < NOTIFY_LIMITS.perHour && total < totalCeiling;
    if (allowed) {
      total += 1;
      if (!critical) normal += 1;
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

/** Why alerts may not be getting through. Short codes; the page explains each in words. */
export type AlertProblem = 'channel' | 'delivery' | 'worker' | 'settings' | 'expired' | 'collector';

/** How old the worker's last cycle may be before it counts as "not running" (3 cycles). */
export const HEARTBEAT_MAX_AGE_MS = 3 * NOTIFY_LIMITS.workerIntervalMs;
/** How far back unsent expired events still count as a problem. */
export const EXPIRED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface HealthInput {
  masterOn: boolean;
  channelReady: boolean;
  /** Status of the latest delivery RESULTS (not claims), newest first (at most 3 are looked at). */
  recentStatuses: readonly DeliveryStatus[];
  /** How long the oldest event with a failed delivery has been waiting, or null. */
  oldestFailingAgeMs: number | null;
  /** Age of the worker's last cycle, or null when it never ran since alerts were switched on. */
  heartbeatAgeMs: number | null;
  /** The stored settings could not be read (so nothing can be sent). */
  settingsProblem: boolean;
  /** Events of the last 7 days that expired without ever being sent. */
  expiredUnsent: number;
  /** The last cycle could not read part of its sources, or could not collect. */
  collectorProblems: number;
}

export function alertProblems(i: HealthInput): AlertProblem[] {
  if (!i.masterOn) return [];
  const out: AlertProblem[] = [];
  if (i.settingsProblem) out.push('settings');
  if (!i.channelReady) out.push('channel');
  const recent = i.recentStatuses.slice(0, 3);
  if (
    (recent.length === 3 && recent.every((s) => s === 'failed')) ||
    (i.oldestFailingAgeMs !== null && i.oldestFailingAgeMs >= NOTIFY_LIMITS.failingAfterMs)
  ) {
    out.push('delivery');
  }
  if (i.heartbeatAgeMs === null || i.heartbeatAgeMs > HEARTBEAT_MAX_AGE_MS) out.push('worker');
  if (i.expiredUnsent > 0) out.push('expired');
  if (i.collectorProblems > 0) out.push('collector');
  return out;
}

/** Shown in the header only when alerts are switched ON and not (fully) getting through. Never blocks. */
export function alertHealth(i: HealthInput): AlertHealth {
  if (!i.masterOn) return 'off';
  return alertProblems(i).length > 0 ? 'failing' : 'ok';
}

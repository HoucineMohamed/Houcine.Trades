import 'server-only';
import type { Db } from '@/data/client';
import {
  claimDue,
  findEventByKey,
  getNotificationSettings,
  insertEvents,
  lastEventAt,
  listRecentEvents,
  recordAttempt,
} from '@/data/notifications';
import {
  makeEvent,
  messageFor,
  passesSettings,
  type ErrorCode,
  type NotificationEvent,
} from '@/domain/notifications';
import type { NotificationChannel, SendResult } from '@/integrations/telegram/types';

/**
 * Delivers pending events. NOTHING here is ever called from a trade, a halt, a risk check or a
 * login: it runs from the worker script and from the guarded "Deliver now" / "Send test" buttons.
 *
 * Nothing is sent unless the master switch is ON and the channel is set up. (The one exception is
 * the single final notice "Alerts were switched off", which is sent after the switch goes off.)
 * A channel that throws, times out or returns junk is just a failed attempt: it is recorded with a
 * short code and retried by the outbox policy (capped backoff, maximum age). Never rethrown.
 */

export interface DeliveryReport {
  sent: number;
  failed: number;
  /** Due events held back by the hourly ceiling (they stay in the outbox). */
  held: number;
  /** Why nothing was attempted, or null. */
  skipped: 'settings_unreadable' | 'channel_not_configured' | 'off' | null;
  /** True when a result could not be written to the log (sending stopped, the rest was released). */
  storageProblem: boolean;
}

export interface DeliveryOptions {
  clock?: () => Date;
  /** Pause between messages (the channel asks for at most one per second to one chat). */
  sleep?: (ms: number) => Promise<void>;
  pacingMs?: number;
  /** Stop between messages when this aborts (Ctrl+C): the rest is released, not lost. */
  signal?: AbortSignal;
}

/** A pause that ends early (and leaves no listener behind) when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function deliverPending(
  db: Db,
  channel: NotificationChannel | null,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => pause(ms, options.signal));
  const pacing = options.pacingMs ?? 1100;
  const report: DeliveryReport = {
    sent: 0,
    failed: 0,
    held: 0,
    skipped: null,
    storageProblem: false,
  };

  const now = clock();
  const settings = getNotificationSettings(db, now);
  if (settings.problem !== null || settings.effective === null) {
    return { ...report, skipped: 'settings_unreadable' };
  }
  const effective = settings.effective;
  const allow = settings.master
    ? (e: NotificationEvent) => passesSettings(e, effective)
    : (e: NotificationEvent) => e.kind === 'notifications_switched_off'; // the final notice only
  if (channel === null) return { ...report, skipped: 'channel_not_configured' };

  const { claimed, held } = claimDue(db, now, channel.name, allow);
  report.held = held;
  let pausedByRateLimit = false;
  let pausedRetryAfterS: number | null = null;
  let stopped = false; // Ctrl+C, or the log cannot be written: the rest is released, not tried
  for (let i = 0; i < claimed.length; i++) {
    const c = claimed[i];
    if (!c) continue;
    if (!stopped && options.signal?.aborted) stopped = true;
    let result: SendResult;
    if (stopped) {
      result = { ok: false, code: 'unexpected', retryAfterS: null }; // released: retried by the outbox rules
    } else if (pausedByRateLimit) {
      result = { ok: false, code: 'rate_limited', retryAfterS: pausedRetryAfterS }; // not even tried: wait as asked
    } else {
      try {
        result = await channel.send(messageFor(c.event));
      } catch {
        result = { ok: false, code: 'unexpected', retryAfterS: null };
      }
    }
    try {
      recordAttempt(db, {
        eventId: c.eventId,
        channel: channel.name,
        status: result.ok ? 'sent' : 'failed',
        at: clock(),
        errorCode: result.ok ? null : (result.code satisfies ErrorCode),
        retryAfterS: result.ok ? null : result.retryAfterS,
      });
    } catch {
      // The log cannot be written. Stop sending (an unlogged send would be repeated) and release the rest.
      report.storageProblem = true;
      stopped = true;
      continue;
    }
    if (result.ok) report.sent += 1;
    else {
      report.failed += 1;
      if (result.code === 'rate_limited' && !pausedByRateLimit && !stopped) {
        pausedByRateLimit = true;
        pausedRetryAfterS = result.retryAfterS;
      }
    }
    if (!stopped && !pausedByRateLimit && i < claimed.length - 1) await sleep(pacing);
  }
  return report;
}

export type TestMessageResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'off' | 'channel_not_configured' | 'failed' | 'held' | 'too_soon';
      code: ErrorCode | null;
    };

/** At most one test message a minute: a double click or a hijacked session cannot buzz the phone at will. */
export const TEST_MESSAGE_GAP_MS = 60_000;

/** "Send test message": needs the master switch ON; recorded and delivered like any other event. */
export async function sendTestMessage(
  db: Db,
  channel: NotificationChannel | null,
  options: DeliveryOptions = {},
): Promise<TestMessageResult> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const settings = getNotificationSettings(db, now);
  if (!settings.master || settings.problem !== null)
    return { ok: false, reason: 'off', code: null };
  if (channel === null) return { ok: false, reason: 'channel_not_configured', code: null };
  const last = lastEventAt(db, 'test_message');
  if (last !== null && now.getTime() - Date.parse(last) < TEST_MESSAGE_GAP_MS) {
    return { ok: false, reason: 'too_soon', code: null };
  }
  const key = `test:${now.toISOString()}`;
  insertEvents(
    db,
    [makeEvent({ kind: 'test_message', dedupeKey: key, occurredAt: now.toISOString() })],
    now,
  );
  await deliverPending(db, channel, options);
  const row = findEventByKey(db, key);
  if (!row) return { ok: false, reason: 'held', code: null };
  const status = listRecentEvents(db, clock(), 50).find((r) => r.id === row.id);
  if (!status) return { ok: false, reason: 'held', code: null };
  if (status.status === 'sent') return { ok: true };
  return { ok: false, reason: status.failures > 0 ? 'failed' : 'held', code: status.lastErrorCode };
}

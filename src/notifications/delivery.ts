import 'server-only';
import {
  claimDue,
  getNotificationSettings,
  insertEvents,
  listRecentEvents,
  recordAttempt,
} from '@/data/notifications';
import type { Db } from '@/data/client';
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
}

export interface DeliveryOptions {
  clock?: () => Date;
  /** Pause between messages (the channel asks for at most one per second to one chat). */
  sleep?: (ms: number) => Promise<void>;
  pacingMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function deliverPending(
  db: Db,
  channel: NotificationChannel | null,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? realSleep;
  const pacing = options.pacingMs ?? 1100;
  const report: DeliveryReport = { sent: 0, failed: 0, held: 0, skipped: null };

  const now = clock();
  const settings = getNotificationSettings(db, now);
  if (settings.problem !== null || settings.effective === null)
    return { ...report, skipped: 'settings_unreadable' };
  const effective = settings.effective;
  const allow = settings.master
    ? (e: NotificationEvent) => passesSettings(e, effective)
    : (e: NotificationEvent) => e.kind === 'notifications_switched_off'; // the final notice only
  if (channel === null) return { ...report, skipped: 'channel_not_configured' };

  const { claimed, held } = claimDue(db, now, channel.name, allow);
  report.held = held;
  let pausedByRateLimit = false;
  let pausedRetryAfterS: number | null = null;
  for (let i = 0; i < claimed.length; i++) {
    const c = claimed[i];
    if (!c) continue;
    let result: SendResult;
    if (pausedByRateLimit) {
      result = { ok: false, code: 'rate_limited', retryAfterS: pausedRetryAfterS }; // not even tried: wait as asked
    } else {
      try {
        result = await channel.send(messageFor(c.event));
      } catch {
        result = { ok: false, code: 'unexpected', retryAfterS: null };
      }
    }
    const code: ErrorCode | null = result.ok ? null : result.code;
    recordAttempt(db, {
      eventId: c.eventId,
      channel: channel.name,
      status: result.ok ? 'sent' : 'failed',
      at: clock(),
      errorCode: code,
      retryAfterS: result.ok ? null : result.retryAfterS,
    });
    if (result.ok) report.sent += 1;
    else {
      report.failed += 1;
      if (result.code === 'rate_limited') {
        pausedByRateLimit = true;
        pausedRetryAfterS = result.retryAfterS;
      }
    }
    if (!pausedByRateLimit && i < claimed.length - 1) await sleep(pacing);
  }
  return report;
}

export type TestMessageResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'off' | 'channel_not_configured' | 'failed' | 'held';
      code: ErrorCode | null;
    };

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
  const key = `test:${now.toISOString()}`;
  insertEvents(
    db,
    [makeEvent({ kind: 'test_message', dedupeKey: key, occurredAt: now.toISOString() })],
    now,
  );
  await deliverPending(db, channel, options);
  const row = listRecentEvents(db, clock(), 20).find((r) => r.event.dedupeKey === key);
  if (!row) return { ok: false, reason: 'held', code: null };
  if (row.status === 'sent') return { ok: true };
  return { ok: false, reason: row.failures > 0 ? 'failed' : 'held', code: row.lastErrorCode };
}

'use server';

import { redirect } from 'next/navigation';
import { setNotificationsMaster, updateNotificationSettings } from '@/data/notifications';
import { ValidationError } from '@/domain/errors';
import type { ErrorCode } from '@/domain/notifications';
import { collectorBaseline } from '@/notifications/collector';
import { deliverPending, sendTestMessage } from '@/notifications/delivery';
import { getChannelRuntime } from '@/notifications/runtime';
import { runCycle } from '@/notifications/worker';
import { errorMessages, formValues } from '../_lib/form';
import {
  guardedAction,
  optionalFreshAuth,
  requireFreshAuth,
  type GuardContext,
} from '../_lib/guard-core';

const back = (kind: 'ok' | 'error', message: string) =>
  `/notifications?${kind}=${encodeURIComponent(message)}`;

const meta = (ctx: GuardContext) => ({
  sessionId: ctx.session.id,
  ip: ctx.client.ip,
  userAgent: ctx.client.userAgent,
});

/** Short codes in plain words. The page never shows anything from the channel itself. */
const CODE_WORDS: Record<ErrorCode, string> = {
  timeout: 'Telegram did not answer in time.',
  network: 'Telegram could not be reached.',
  unauthorized: 'Telegram did not accept the bot token (it may be revoked or mistyped).',
  forbidden: 'Telegram refused to deliver to this chat (the bot may be blocked or not started).',
  rate_limited: 'Telegram asked us to slow down.',
  bad_request: 'Telegram refused the request.',
  server_error: 'Telegram had a problem on its side.',
  bad_response: 'Telegram answered in a form that could not be verified, so it was not trusted.',
  conflict: 'Telegram reported a conflict.',
  not_configured: 'Telegram is not set up.',
  unexpected: 'Something unexpected happened while sending.',
};

/** ON needs the consent box and a fresh code; OFF needs a fresh code too (and sends one last notice). */
export const setMasterAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    const now = new Date();
    if (v.master === 'on') {
      if (v.understood !== 'yes') {
        throw new ValidationError([
          { field: '', message: 'Tick the box to confirm you read what is sent and what is not.' },
        ]);
      }
      const runtime = getChannelRuntime();
      if (!runtime.configured) {
        throw new ValidationError([
          { field: '', message: runtime.message ?? 'Telegram is not set up.' },
        ]);
      }
      const auth = requireFreshAuth(ctx, formData, 'turning on alerts');
      const baseline = collectorBaseline(ctx.db, now);
      if (baseline.problems.length > 0) {
        // Starting from a state that could not be read would announce old levels as new: refuse instead.
        throw new ValidationError([
          {
            field: '',
            message: `Alerts cannot be turned on yet: part of the current state could not be read (${baseline.problems.join(', ')}).`,
          },
        ]);
      }
      setNotificationsMaster(ctx.db, true, auth, now, meta(ctx), baseline.state);
      target = back(
        'ok',
        'Alerts are ON. Only events from now on are announced. The change was logged.',
      );
    } else {
      const auth = requireFreshAuth(ctx, formData, 'turning off alerts');
      setNotificationsMaster(ctx.db, false, auth, now, meta(ctx));
      // The one last message. A failure here never blocks the switch; the owner is told what happened.
      let finalNotice =
        'The final notice could not be sent right now (it is retried by the worker for up to 24 hours).';
      try {
        const r = await deliverPending(ctx.db, getChannelRuntime().channel);
        if (r.sent > 0) finalNotice = 'One last notice, "Alerts were switched off", was sent.';
      } catch {
        // recorded in the outbox; the sentence above says so
      }
      target = back(
        'ok',
        `Alerts are OFF. Nothing more is sent except that one last notice. ${finalNotice} The change was logged.`,
      );
    }
  } catch (error) {
    target = back('error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

/** Categories and minimum severity: louder applies now; quieter needs a code and waits 24 hours. */
export const updateSettingsAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    const result = updateNotificationSettings(
      ctx.db,
      {
        categories: {
          risk: v.cat_risk === 'on',
          security: v.cat_security === 'on',
          analyst: v.cat_analyst === 'on',
          system: v.cat_system === 'on',
        },
        minSeverity: v.minSeverity ?? '',
      },
      optionalFreshAuth(ctx, formData),
      new Date(),
      meta(ctx),
    );
    const parts: string[] = [];
    if (result.applied.length > 0) parts.push(`Applied now: ${result.applied.join(', ')}`);
    if (result.deferred.length > 0) {
      parts.push(
        `Waiting 24 hours: ${result.deferred.map((d) => `${d.what} at ${d.effectiveAt}`).join(', ')}`,
      );
    }
    if (result.cancelled.length > 0)
      parts.push(`Cancelled pending change: ${result.cancelled.join(', ')}`);
    target = back('ok', parts.length > 0 ? parts.join('. ') : 'Nothing changed.');
  } catch (error) {
    target = back('error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

export const testMessageAction = guardedAction(async (ctx) => {
  let target: string;
  try {
    const r = await sendTestMessage(ctx.db, getChannelRuntime().channel);
    if (r.ok) target = back('ok', 'The test message was sent. Check your phone.');
    else if (r.reason === 'off')
      target = back('error', 'Alerts are OFF, so nothing is sent. Turn them on first.');
    else if (r.reason === 'too_soon')
      target = back(
        'error',
        'A test message was sent a moment ago. Wait a minute before sending another.',
      );
    else if (r.reason === 'channel_not_configured')
      target = back('error', 'Telegram is not set up (see docs/notifications.md).');
    else
      target = back(
        'error',
        r.code ? CODE_WORDS[r.code] : 'The test message is waiting in the outbox.',
      );
  } catch {
    target = back('error', 'The test message could not be sent. Nothing else is affected.');
  }
  redirect(target);
});

/** "Deliver now": collect new events and send what is pending, once. */
export const deliverNowAction = guardedAction(async (ctx) => {
  let target: string;
  try {
    const r = await runCycle(ctx.db, getChannelRuntime().channel);
    if (r.errors.length > 0)
      target = back(
        'error',
        'Something went wrong. Nothing else is affected; the events stay in the outbox.',
      );
    else if (r.deliver?.skipped === 'channel_not_configured')
      target = back('error', 'Telegram is not set up (see docs/notifications.md).');
    else if (r.problems.length > 0)
      target = back(
        'error',
        `Done, but with problems: ${r.problems.join(', ')}. Nothing else is affected.`,
      );
    else {
      const d = r.deliver;
      target = back(
        'ok',
        `Done: ${d?.sent ?? 0} sent, ${d?.failed ?? 0} failed, ${d?.held ?? 0} held back by the hourly ceiling.`,
      );
    }
  } catch {
    target = back(
      'error',
      'Something went wrong. Nothing else is affected; the events stay in the outbox.',
    );
  }
  redirect(target);
});

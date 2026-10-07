'use server';

import { redirect } from 'next/navigation';
import { loadPlanReviewFacts, loadTutorFacts, loadWeeklyFacts } from '@/analyst/inputs';
import { getAnalystRuntime } from '@/analyst/runtime';
import { runAnalyst, type AnalystOutcome } from '@/analyst/service';
import { setAiConsent, updateAiCaps } from '@/data/analyst';
import type { GuardContext } from '../_lib/guard-core';
import {
  buildPlanReviewPrompt,
  buildTutorPrompt,
  buildWeeklyReviewPrompt,
  scrubSensitive,
  type AiCapField,
  type AnalystKind,
  type BuiltPrompt,
} from '@/domain/analyst';
import { ValidationError } from '@/domain/errors';
import { aiCapLabel } from '@/domain/analyst';
import { planFromForm } from '../trades/mapping';
import { errorMessages, formValues, toId, type FormValues } from '../_lib/form';
import { guardedAction, optionalFreshAuth, requireFreshAuth } from '../_lib/guard-core';
import type { AnalystActionResult } from './types';

const meta = (ctx: GuardContext) => ({
  sessionId: ctx.session.id,
  ip: ctx.client.ip,
  userAgent: ctx.client.userAgent,
});

const back = (path: string, kind: 'ok' | 'error', message: string) =>
  `${path}?${kind}=${encodeURIComponent(message)}`;

function toResult(kind: AnalystKind, outcome: AnalystOutcome): AnalystActionResult {
  if (!outcome.ok) return { ok: false, message: outcome.message };
  return {
    ok: true,
    reviewId: outcome.reviewId,
    kind,
    output: outcome.output,
    checks: outcome.checks,
    fromStore: outcome.fromStore,
    createdAt: outcome.createdAt,
  };
}

async function run(
  ctx: GuardContext,
  built: BuiltPrompt,
  m: Parameters<typeof runAnalyst>[3],
): Promise<AnalystActionResult> {
  try {
    return toResult(
      built.kind,
      await runAnalyst(ctx.db, getAnalystRuntime(), built, m, new Date()),
    );
  } catch {
    // Any unexpected problem is shown as one plain sentence; details never reach the page.
    return {
      ok: false,
      message:
        'The analyst stopped unexpectedly. Look at "Recent requests" on the Analyst page to see whether anything was sent.',
    };
  }
}

// ---- the privacy switch -------------------------------------------------------------------------

/** Turning the switch ON needs the consent box and a fresh code; turning it OFF needs nothing. */
export const setConsentAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    if (v.consent === 'on') {
      if (v.understood !== 'yes') {
        throw new ValidationError([
          { field: '', message: 'Tick the box to confirm you read what is sent and what is not.' },
        ]);
      }
      const auth = requireFreshAuth(ctx, formData, 'turning on "Send journal data to the AI"');
      setAiConsent(ctx.db, true, auth, new Date(), meta(ctx));
      target = back('/analyst', 'ok', 'The privacy switch is ON. The change was logged.');
    } else {
      setAiConsent(ctx.db, false, null, new Date(), meta(ctx));
      target = back(
        '/analyst',
        'ok',
        'The privacy switch is OFF. Nothing is sent. The change was logged.',
      );
    }
  } catch (error) {
    target = back('/analyst', 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

// ---- caps ---------------------------------------------------------------------------------------

export const updateCapsAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    const result = updateAiCaps(
      ctx.db,
      {
        dailyCalls: toId(v.dailyCalls),
        monthlyCalls: toId(v.monthlyCalls),
        monthlyCostUsd: v.monthlyCostUsd ?? '',
      },
      // Tightening needs no code; loosening needs a fresh one (the data layer decides).
      optionalFreshAuth(ctx, formData),
      new Date(),
      meta(ctx),
    );
    const parts: string[] = [];
    if (result.applied.length > 0) {
      parts.push(
        'Applied now (tightened): ' +
          result.applied
            .map((a) => `${aiCapLabel(a.field as AiCapField)} ${a.from} → ${a.to}`)
            .join(', '),
      );
    }
    if (result.deferred.length > 0) {
      parts.push(
        'Waiting 24 hours (loosened): ' +
          result.deferred
            .map((d) => `${aiCapLabel(d.field as AiCapField)} → ${d.value} at ${d.effectiveAt}`)
            .join(', '),
      );
    }
    if (result.cancelled.length > 0) {
      parts.push(
        'Cancelled pending change: ' + result.cancelled.map((f) => aiCapLabel(f)).join(', '),
      );
    }
    target = back('/analyst', 'ok', parts.length > 0 ? parts.join('. ') : 'Nothing changed.');
  } catch (error) {
    target = back('/analyst', 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

// ---- features -----------------------------------------------------------------------------------

/** "Ask the analyst" on the new-trade form. The verdict is recomputed here by the real engine. */
export const askPlanReviewAction = guardedAction(
  async (ctx, values: FormValues): Promise<AnalystActionResult> => {
    let accountId: number;
    let plan: ReturnType<typeof planFromForm>['plan'];
    let built: BuiltPrompt;
    try {
      ({ accountId, plan } = planFromForm(values));
      const loaded = loadPlanReviewFacts(
        ctx.db,
        {
          accountId,
          plan,
          setupId: toId(values.setupId) ?? null,
          planNotes: values.planNotes ?? '',
          emotion: values.emotion ?? '',
        },
        new Date(),
      );
      if (!loaded.ok) return { ok: false, message: loaded.message };
      built = buildPlanReviewPrompt(loaded.facts);
    } catch (error) {
      // a half-filled form: say which field, never crash the form
      try {
        return { ok: false, message: errorMessages(error).join(' | ') };
      } catch {
        return { ok: false, message: 'The analyst could not read this plan. Nothing was sent.' };
      }
    }
    const subject = scrubSensitive(
      `${plan.symbol} ${plan.direction} entry ${plan.entry ?? '?'} stop ${plan.stop ?? '?'} size ${plan.size ?? '?'}`,
    ).slice(0, 200);
    return run(ctx, built, { accountId, subject });
  },
);

function reviewTarget(result: AnalystActionResult, failPath: string): string {
  return result.ok
    ? `/analyst/reviews/${result.reviewId}${result.fromStore ? '?stored=1' : ''}`
    : back(failPath, 'error', result.message);
}

export const runWeeklyAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const accountId = toId(v.accountId) ?? 0;
  const loaded = loadWeeklyFacts(ctx.db, {
    accountId,
    from: (v.from ?? '').trim(),
    to: (v.to ?? '').trim(),
    currency: v.currency ?? '',
  });
  let result: AnalystActionResult;
  if (!loaded.ok) result = { ok: false, message: loaded.message };
  else {
    result = await run(ctx, buildWeeklyReviewPrompt(loaded.facts), {
      accountId,
      rangeFrom: loaded.facts.from,
      rangeTo: loaded.facts.to,
      currency: loaded.facts.currency,
      subject: `${loaded.facts.from} to ${loaded.facts.to}, ${loaded.facts.currency}`,
    });
  }
  redirect(reviewTarget(result, '/analyst/review'));
});

export const runTutorAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const question = (v.question ?? '').trim();
  let result: AnalystActionResult;
  if (question === '') result = { ok: false, message: 'Type a question first.' };
  else {
    const facts = loadTutorFacts(ctx.db, question, toId(v.accountId) ?? null);
    result = await run(ctx, buildTutorPrompt(facts), {
      accountId: toId(v.accountId) ?? null,
      subject: scrubSensitive(question).slice(0, 300),
    });
  }
  redirect(reviewTarget(result, '/analyst/tutor'));
});

'use server';

import { redirect } from 'next/navigation';
import {
  haltManually,
  resetHalt,
  restoreDefaultRiskSettings,
  updateRiskSettings,
} from '@/data/risk';
import { riskFieldLabel, type SettingsChangeResult } from '@/domain/risk';
import { guardedAction } from '../_lib/guard-core';
import { errorMessages, formValues, toId } from '../_lib/form';

const back = (accountId: number | undefined, kind: 'ok' | 'error', message: string) =>
  `/risk?account=${accountId ?? ''}&${kind}=${encodeURIComponent(message)}`;

function describe(result: SettingsChangeResult): string {
  const parts: string[] = [];
  if (result.applied.length > 0) {
    parts.push(
      'Applied now (tightened): ' +
        result.applied.map((a) => `${riskFieldLabel(a.field)} ${a.from} → ${a.to}`).join(', '),
    );
  }
  if (result.deferred.length > 0) {
    parts.push(
      'Waiting 24 hours (loosened): ' +
        result.deferred
          .map((d) => `${riskFieldLabel(d.field)} → ${d.value} at ${d.effectiveAt}`)
          .join(', '),
    );
  }
  if (result.cancelled.length > 0) {
    parts.push('Cancelled pending change: ' + result.cancelled.map(riskFieldLabel).join(', '));
  }
  return parts.length > 0 ? parts.join('. ') : 'Nothing changed.';
}

export const updateSettingsAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const accountId = toId(v.accountId);
  let target: string;
  try {
    const result = updateRiskSettings(ctx.db, accountId ?? -1, {
      maxRiskPerTradePercent: v.maxRiskPerTradePercent,
      maxDailyLossPercent: v.maxDailyLossPercent,
      maxOpenRiskPercent: v.maxOpenRiskPercent,
      maxOpenTrades: toId(v.maxOpenTrades),
      maxDrawdownPercent: v.maxDrawdownPercent,
      minRewardToRisk: v.minRewardToRisk,
    });
    target = back(accountId, 'ok', describe(result));
  } catch (error) {
    target = back(accountId, 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

/** The kill switch. */
export const haltAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const accountId = toId(v.accountId);
  let target: string;
  try {
    haltManually(ctx.db, accountId ?? -1, v.reason ?? '');
    target = back(
      accountId,
      'ok',
      'Trading is halted. Every new plan is refused until you reset the halt.',
    );
  } catch (error) {
    target = back(accountId, 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

export const resetAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const accountId = toId(v.accountId);
  const kind = v.haltKind === 'drawdown' ? 'drawdown' : 'manual';
  let target: string;
  try {
    resetHalt(ctx.db, accountId ?? -1, kind, { confirm: v.confirm, reason: v.reason });
    target = back(accountId, 'ok', `The ${kind} halt was reset and the reset was logged.`);
  } catch (error) {
    target = back(accountId, 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

/** Recovery when the stored settings are corrupt. */
export const restoreDefaultsAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  const accountId = toId(v.accountId);
  let target: string;
  try {
    restoreDefaultRiskSettings(ctx.db, accountId ?? -1, {
      confirm: v.confirm,
      reason: v.reason,
    });
    target = back(
      accountId,
      'ok',
      'The default risk settings were restored and the change was logged.',
    );
  } catch (error) {
    target = back(accountId, 'error', errorMessages(error).join(' | '));
  }
  redirect(target);
});

'use server';

import { redirect } from 'next/navigation';
import { evaluatePlanForAccount } from '@/data/risk';
import { closeTradeAndSync, logTrade, openTradeChecked, RiskRefusalError } from '@/data/journal';
import { cancelTrade, updateTrade } from '@/data/trades';
import type { VerdictNumbers } from '@/domain/risk';
import { requireDb } from '../_lib/db';
import { errorMessages, formValues, toId, type FormState, type FormValues } from '../_lib/form';
import {
  closeInputFromForm,
  createInputFromForm,
  editPatchFromForm,
  openInputFromForm,
  overrideFromForm,
  planFromForm,
} from './mapping';

const ok = (message: string) => '/trades?ok=' + encodeURIComponent(message);
const failed = (error: unknown) =>
  '/trades?error=' + encodeURIComponent(refusalOrMessages(error).join(' | '));

/** The risk engine's refusal as plain messages (all of them), or the usual validation messages. */
function refusalOrMessages(error: unknown): string[] {
  if (error instanceof RiskRefusalError) return error.verdict.violations.map((v) => v.message);
  return errorMessages(error);
}

export interface RiskPreview {
  approved: boolean;
  violations: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  numbers: VerdictNumbers;
}

/**
 * Live risk verdict for the plan in the form. READ ONLY: it saves nothing. The same engine and
 * the same rules that will judge the real submission.
 */
export async function previewRiskAction(values: FormValues): Promise<RiskPreview> {
  const { accountId, plan } = planFromForm(values);
  const { verdict } = evaluatePlanForAccount(await requireDb(), accountId, plan);
  return {
    approved: verdict.approved,
    violations: verdict.violations,
    warnings: verdict.warnings,
    numbers: verdict.numbers,
  };
}

/**
 * Create form: the plan goes through the risk engine. If it is refused, the form is shown again
 * with every reason and the override fields (type OVERRIDE and a reason to log it anyway).
 */
export async function createTradeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData);
  try {
    logTrade(await requireDb(), createInputFromForm(values), {
      override: overrideFromForm(values),
    });
  } catch (error) {
    if (error instanceof RiskRefusalError) {
      return {
        errors: [
          'The risk engine refused this plan:',
          ...error.verdict.violations.map((v) => v.message),
        ],
        values,
        needsOverride: true,
      };
    }
    return { errors: errorMessages(error), values };
  }
  redirect(ok('Trade created'));
}

/** Edit form (id is bound by the page). */
export async function updateTradeAction(
  id: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = formValues(formData);
  try {
    updateTrade(await requireDb(), id, editPatchFromForm(values));
  } catch (error) {
    return { errors: errorMessages(error), values };
  }
  redirect(ok('Trade updated'));
}

export async function openTradeAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    openTradeChecked(await requireDb(), toId(v.id) ?? -1, openInputFromForm(v), {
      override: overrideFromForm(v),
    });
    target = ok('Trade opened');
  } catch (error) {
    target = failed(error);
  }
  redirect(target);
}

/** Closing is never blocked by risk rules (it only reduces risk). */
export async function closeTradeAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    closeTradeAndSync(await requireDb(), toId(v.id) ?? -1, closeInputFromForm(v));
    target = ok('Trade closed');
  } catch (error) {
    target = failed(error);
  }
  redirect(target);
}

export async function cancelTradeAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    cancelTrade(await requireDb(), toId(v.id) ?? -1);
    target = ok('Trade cancelled');
  } catch (error) {
    target = failed(error);
  }
  redirect(target);
}

'use server';

import { redirect } from 'next/navigation';
import { evaluatePlanForAccount, loadRiskContext } from '@/data/risk';
import { closeTradeAndSync, logTrade, openTradeChecked, RiskRefusalError } from '@/data/journal';
import { cancelTrade, updateTrade } from '@/data/trades';
import { StepUpRequiredError } from '@/domain/auth/stepup';
import { calculatePositionSize, type VerdictNumbers } from '@/domain/risk';
import { guardedAction, optionalFreshAuth } from '../_lib/guard-core';
import { errorMessages, formValues, toId, type FormState, type FormValues } from '../_lib/form';
import {
  closeInputFromForm,
  createInputFromForm,
  editPatchFromForm,
  openInputFromForm,
  overrideFromForm,
  planFromForm,
} from './mapping';

/** Back to the trade's own page when there is one, else the journal list. */
const base = (id?: number) => (id !== undefined && id > 0 ? `/trades/${id}` : '/trades');
const ok = (message: string, id?: number) => `${base(id)}?ok=` + encodeURIComponent(message);
const failed = (error: unknown, id?: number) =>
  `${base(id)}?error=` + encodeURIComponent(refusalOrMessages(error).join(' | '));

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
export const previewRiskAction = guardedAction(
  async (ctx, values: FormValues): Promise<RiskPreview> => {
    const { accountId, plan } = planFromForm(values);
    const { verdict } = evaluatePlanForAccount(ctx.db, accountId, plan);
    return {
      approved: verdict.approved,
      violations: verdict.violations,
      warnings: verdict.warnings,
      numbers: verdict.numbers,
    };
  },
);

/**
 * Create form: the plan goes through the risk engine. If it is refused, the form is shown again
 * with every reason and the override fields (type OVERRIDE and a reason to log it anyway).
 */
export const createTradeAction = guardedAction(
  async (ctx, _prev: FormState, formData: FormData): Promise<FormState> => {
    const values = formValues(formData);
    let createdId: number;
    try {
      const created = logTrade(ctx.db, createInputFromForm(values), {
        override: overrideFromForm(values),
        // Needed only when a refused plan is logged anyway (an override).
        auth: optionalFreshAuth(ctx, formData),
      });
      createdId = created.trade.id;
    } catch (error) {
      if (error instanceof StepUpRequiredError) {
        // Keep the override fields on screen so the code can be typed and the form re-sent.
        return { errors: errorMessages(error), values, needsOverride: true };
      }
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
    redirect(ok('Trade created', createdId));
  },
);

/** Edit form (id is bound by the page). */
export const updateTradeAction = guardedAction(
  async (ctx, id: number, _prev: FormState, formData: FormData): Promise<FormState> => {
    const values = formValues(formData);
    try {
      updateTrade(ctx.db, id, editPatchFromForm(values));
    } catch (error) {
      return { errors: errorMessages(error), values };
    }
    redirect(ok('Trade updated', id));
  },
);

export const openTradeAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    openTradeChecked(ctx.db, toId(v.id) ?? -1, openInputFromForm(v), {
      override: overrideFromForm(v),
      auth: optionalFreshAuth(ctx, formData),
    });
    target = ok('Trade opened', toId(v.id));
  } catch (error) {
    target = failed(error, toId(v.id));
  }
  redirect(target);
});

/** Closing is never blocked by risk rules (it only reduces risk). */
export const closeTradeAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    closeTradeAndSync(ctx.db, toId(v.id) ?? -1, closeInputFromForm(v));
    target = ok('Trade closed', toId(v.id));
  } catch (error) {
    target = failed(error, toId(v.id));
  }
  redirect(target);
});

export const cancelTradeAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    cancelTrade(ctx.db, toId(v.id) ?? -1);
    target = ok('Trade cancelled', toId(v.id));
  } catch (error) {
    target = failed(error, toId(v.id));
  }
  redirect(target);
});

export interface SizeSuggestion {
  ok: boolean;
  /** The risk limit the size was worked out for (percent of equity). */
  riskPercent: string | null;
  size: string | null;
  riskAmount: string | null;
  riskPercentUsed: string | null;
  notional: string | null;
  problems: string[];
}

/**
 * The largest size inside the per-trade risk limit for the plan in the form. READ ONLY, and the
 * maths is the risk engine's own calculator (never done in the page).
 */
export const sizeSuggestionAction = guardedAction(
  async (ctx, values: FormValues): Promise<SizeSuggestion> => {
    const { accountId, plan } = planFromForm(values);
    const context = loadRiskContext(ctx.db, accountId, ctx.now);
    const riskPercent = context.settings?.maxRiskPerTradePercent ?? null;
    const result = calculatePositionSize({
      equity: context.equity,
      riskPercent,
      direction: plan.direction,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
    });
    if (!result.ok) {
      return {
        ok: false,
        riskPercent,
        size: null,
        riskAmount: null,
        riskPercentUsed: null,
        notional: null,
        problems: result.problems.map((p) => p.message),
      };
    }
    return {
      ok: true,
      riskPercent,
      size: result.size,
      riskAmount: result.riskAmount,
      riskPercentUsed: result.riskPercentUsed,
      notional: result.notional,
      problems: [],
    };
  },
);

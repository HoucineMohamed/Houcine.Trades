'use server';

import { redirect } from 'next/navigation';
import { cancelTrade, closeTrade, createTrade, openTrade, updateTrade } from '@/data/trades';
import { requireDb } from '../_lib/db';
import { errorMessages, formValues, toId, type FormState } from '../_lib/form';
import {
  closeInputFromForm,
  createInputFromForm,
  editPatchFromForm,
  openInputFromForm,
} from './mapping';

const ok = (message: string) => '/trades?ok=' + encodeURIComponent(message);
const failed = (error: unknown) =>
  '/trades?error=' + encodeURIComponent(errorMessages(error).join(' | '));

/** Create form: on error the form is shown again with what the user typed. */
export async function createTradeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData);
  try {
    createTrade(await requireDb(), createInputFromForm(values));
  } catch (error) {
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
    openTrade(await requireDb(), toId(v.id) ?? -1, openInputFromForm(v));
    target = ok('Trade opened');
  } catch (error) {
    target = failed(error);
  }
  redirect(target);
}

export async function closeTradeAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    closeTrade(await requireDb(), toId(v.id) ?? -1, closeInputFromForm(v));
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

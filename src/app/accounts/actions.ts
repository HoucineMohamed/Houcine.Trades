'use server';

import { redirect } from 'next/navigation';
import { createAccount } from '@/data/accounts';
import { guardedAction } from '../_lib/guard-core';
import { errorMessages, formValues } from '../_lib/form';

export const createAccountAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    // "mode" is not sent: new accounts are always paper (the guard also enforces it).
    createAccount(ctx.db, {
      name: v.name,
      baseCurrency: v.baseCurrency,
      startingBalance: v.startingBalance,
    });
    target = '/accounts?ok=' + encodeURIComponent('Account created');
  } catch (error) {
    target = '/accounts?error=' + encodeURIComponent(errorMessages(error).join(' | '));
  }
  redirect(target);
});

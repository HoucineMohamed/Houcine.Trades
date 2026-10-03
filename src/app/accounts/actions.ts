'use server';

import { redirect } from 'next/navigation';
import { createAccount } from '@/data/accounts';
import { requireDb } from '../_lib/db';
import { errorMessages, formValues } from '../_lib/form';

export async function createAccountAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    // "mode" is not sent: new accounts are always paper (the guard also enforces it).
    createAccount(await requireDb(), {
      name: v.name,
      baseCurrency: v.baseCurrency,
      startingBalance: v.startingBalance,
    });
    target = '/accounts?ok=' + encodeURIComponent('Account created');
  } catch (error) {
    target = '/accounts?error=' + encodeURIComponent(errorMessages(error).join(' | '));
  }
  redirect(target);
}

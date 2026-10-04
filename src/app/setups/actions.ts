'use server';

import { redirect } from 'next/navigation';
import { createSetup } from '@/data/setups';
import { guardedAction } from '../_lib/guard-core';
import { errorMessages, formValues } from '../_lib/form';

export const createSetupAction = guardedAction(async (ctx, formData: FormData) => {
  const v = formValues(formData);
  let target: string;
  try {
    createSetup(ctx.db, { name: v.name, description: v.description ?? '' });
    target = '/setups?ok=' + encodeURIComponent('Setup created');
  } catch (error) {
    target = '/setups?error=' + encodeURIComponent(errorMessages(error).join(' | '));
  }
  redirect(target);
});

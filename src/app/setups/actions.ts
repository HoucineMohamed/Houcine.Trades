'use server';

import { redirect } from 'next/navigation';
import { createSetup } from '@/data/setups';
import { requireDb } from '../_lib/db';
import { errorMessages, formValues } from '../_lib/form';

export async function createSetupAction(formData: FormData) {
  const v = formValues(formData);
  let target: string;
  try {
    createSetup(await requireDb(), { name: v.name, description: v.description ?? '' });
    target = '/setups?ok=' + encodeURIComponent('Setup created');
  } catch (error) {
    target = '/setups?error=' + encodeURIComponent(errorMessages(error).join(' | '));
  }
  redirect(target);
}

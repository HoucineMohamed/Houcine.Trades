'use server';

import { redirect } from 'next/navigation';
import { stepUp } from '@/auth/service';
import { guardedAction } from '../_lib/guard-core';

/** Only plain in-site paths: never an address on another site. */
const safeNext = (value: unknown): string =>
  typeof value === 'string' && /^\/[A-Za-z0-9/_-]{0,100}$/.test(value) && !value.startsWith('//')
    ? value
    : '/';

/** Checks a fresh authenticator code. A good code unlocks sensitive actions for 5 minutes. */
export const stepUpAction = guardedAction(async (ctx, formData: FormData) => {
  const next = safeNext(formData.get('next'));
  const result = stepUp(ctx.db, ctx.session, formData.get('code'), ctx.client, {
    env: ctx.env,
    now: ctx.now,
  });
  if (result.ok) redirect(next);
  const q = new URLSearchParams({ next });
  if (result.reason === 'throttled') {
    q.set('e', 'throttled');
    q.set('wait', String(Math.ceil(result.retryAfterMs / 1000)));
  } else {
    q.set('e', 'invalid');
  }
  redirect(`/step-up?${q.toString()}`);
});

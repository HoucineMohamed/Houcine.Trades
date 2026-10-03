'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { login } from '@/auth/service';
import { sessionCookieAttributes, sessionCookieName } from '@/auth/cookies';
import { publicAction } from '../_lib/guard-core';

/**
 * The only public action. One generic failure for every wrong credential: it never says whether
 * the password or the code was wrong. The password and the code are never put in a URL or logged.
 */
export const loginAction = publicAction(async (ctx, formData: FormData) => {
  if (!ctx.env) redirect('/login?e=not_configured');
  const result = await login(
    ctx.db,
    { password: formData.get('password'), code: formData.get('code') },
    ctx.client,
    { env: ctx.env, now: ctx.now },
  );
  if (!result.ok) {
    if (result.reason === 'throttled') {
      redirect(`/login?e=throttled&wait=${Math.ceil(result.retryAfterMs / 1000)}`);
    }
    redirect(`/login?e=${result.reason}`);
  }
  (await cookies()).set(
    sessionCookieName(ctx.https),
    result.token,
    sessionCookieAttributes(ctx.https, ctx.env.session.absoluteMs),
  );
  redirect(result.usedRecoveryCode ? '/security?recovery=used' : '/');
});

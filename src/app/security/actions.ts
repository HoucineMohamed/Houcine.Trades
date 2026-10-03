'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { logout } from '@/auth/service';
import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from '@/auth/cookies';
import { guardedAction } from '../_lib/guard-core';

export const logoutAction = guardedAction(async (ctx) => {
  logout(ctx.db, ctx.session, ctx.client, { env: ctx.env, now: ctx.now });
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_PLAIN);
  jar.delete(SESSION_COOKIE_SECURE);
  redirect('/login');
});

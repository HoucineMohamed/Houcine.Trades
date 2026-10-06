'use server';

import { cookies } from 'next/headers';
import { listAccounts } from '@/data/accounts';
import { ACCOUNT_COOKIE, parseAccountId, parseTheme, THEME_COOKIE } from './account';
import { guardedAction } from './guard-core';

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Light, dark or follow the system. Only a display preference, but still behind the guard. */
export const setThemeAction = guardedAction(async (ctx, formData: FormData) => {
  const theme = parseTheme(String(formData.get('theme') ?? ''));
  const jar = await cookies();
  if (theme === 'system') {
    jar.delete(THEME_COOKIE);
    return;
  }
  jar.set(THEME_COOKIE, theme, {
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.https,
    path: '/',
    maxAge: ONE_YEAR,
  });
});

/** Remembers which account the pages show. An unknown id is ignored. */
export const selectAccountAction = guardedAction(async (ctx, formData: FormData) => {
  const id = parseAccountId(String(formData.get('accountId') ?? ''));
  if (id === null || !listAccounts(ctx.db).some((a) => a.id === id)) return;
  (await cookies()).set(ACCOUNT_COOKIE, String(id), {
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.https,
    path: '/',
    maxAge: ONE_YEAR,
  });
});

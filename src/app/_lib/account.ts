import 'server-only';
import { cookies } from 'next/headers';
import { listAccounts, type Account } from '@/data/accounts';
import type { GuardContext } from './guard-core';

/** Cookie names of the two display preferences (neither is a secret). */
export const ACCOUNT_COOKIE = 'houcine_account';
export const THEME_COOKIE = 'houcine_theme';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function parseTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function parseAccountId(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

/** Every account, and the one selected in the header (the remembered one, else the first). */
export async function selectedAccount(
  ctx: GuardContext,
): Promise<{ accounts: Account[]; selected: Account | null }> {
  const accounts = listAccounts(ctx.db);
  const wanted = parseAccountId((await cookies()).get(ACCOUNT_COOKIE)?.value);
  const selected = accounts.find((a) => a.id === wanted) ?? accounts[0] ?? null;
  return { accounts, selected };
}

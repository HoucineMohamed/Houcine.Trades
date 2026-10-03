'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from '@/auth/cookies';
import { changePassword, logout, logoutEverywhere, regenerateRecoveryCodes } from '@/auth/service';
import { StepUpRequiredError } from '@/domain/auth/stepup';
import { guardedAction, requireFreshAuth } from '../_lib/guard-core';
import type { SecurityFormState } from './state';

async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_PLAIN);
  jar.delete(SESSION_COOKIE_SECURE);
}

export const logoutAction = guardedAction(async (ctx) => {
  logout(ctx.db, ctx.session, ctx.client, { env: ctx.env, now: ctx.now });
  await clearSessionCookies();
  redirect('/login');
});

const needsCode = (error: unknown): SecurityFormState | null =>
  error instanceof StepUpRequiredError
    ? {
        error: `${error.message}. Type your current 6-digit authenticator code in the code box and try again.`,
      }
    : null;

/** Ends every session, this one included. Needs a fresh code. */
export const logoutEverywhereAction = guardedAction(
  async (ctx, _prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> => {
    try {
      const auth = requireFreshAuth(ctx, formData, 'logging out everywhere');
      logoutEverywhere(ctx.db, ctx.session, auth, ctx.client, { env: ctx.env, now: ctx.now });
    } catch (error) {
      const known = needsCode(error);
      if (known) return known;
      throw error;
    }
    await clearSessionCookies();
    redirect('/login');
  },
);

/** Needs a fresh code AND the current password. Every other session is ended. */
export const changePasswordAction = guardedAction(
  async (ctx, _prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> => {
    const current = formData.get('currentPassword');
    const next = formData.get('newPassword');
    const again = formData.get('newPasswordAgain');
    if (next !== again) return { error: 'The two new passwords are not the same.' };
    try {
      const auth = requireFreshAuth(ctx, formData, 'changing the password');
      const result = await changePassword(
        ctx.db,
        ctx.session,
        { currentPassword: current, newPassword: next },
        auth,
        ctx.client,
        { env: ctx.env, now: ctx.now },
      );
      if (result.ok) {
        return { message: 'Password changed. Every other session was signed out.' };
      }
      if (result.reason === 'throttled') {
        return {
          error: `Too many attempts. Wait ${Math.ceil(result.retryAfterMs / 1000)} seconds.`,
        };
      }
      if (result.reason === 'weak_password') return { error: result.problems.join(' ') };
      return { error: 'The current password was not accepted.' };
    } catch (error) {
      const known = needsCode(error);
      if (known) return known;
      throw error;
    }
  },
);

/** Needs a fresh code. The old unused codes stop working; the new ones are shown once. */
export const regenerateCodesAction = guardedAction(
  async (ctx, _prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> => {
    try {
      const auth = requireFreshAuth(ctx, formData, 'regenerating the recovery codes');
      const codes = regenerateRecoveryCodes(ctx.db, ctx.session, auth, ctx.client, {
        env: ctx.env,
        now: ctx.now,
      });
      return {
        message: 'New recovery codes. Save them now: they are shown only once.',
        codes,
      };
    } catch (error) {
      const known = needsCode(error);
      if (known) return known;
      throw error;
    }
  },
);

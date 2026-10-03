import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { clientInfoFromHeaders, type ClientInfo } from '@/auth/client';
import { isHttpsRequest, readSessionToken } from '@/auth/cookies';
import { getAuthEnv, type AuthEnv } from '@/auth/env';
import { checkOrigin } from '@/auth/request-checks';
import { freshAuthFor, stepUp, verifySession, type SessionInfo } from '@/auth/service';
import { getDb, type Db } from '@/data/client';
import { assertFreshAuth, StepUpRequiredError, type FreshAuth } from '@/domain/auth/stepup';

/**
 * THE guard. Every page, server action and route handler in src/app is wrapped by one of the
 * functions below, and a test (tests/auth/guard-coverage.test.ts) fails if any entry point is not.
 * The database is reachable only through the context these wrappers hand out (ESLint stops
 * src/app from importing the database client), so "forgetting the check" cannot reach data.
 *
 * proxy.ts is only a first, cheap line of defence; the real session check happens here.
 */

export interface GuardContext {
  db: Db;
  session: SessionInfo;
  env: AuthEnv;
  now: Date;
  client: ClientInfo;
  https: boolean;
  /** Proof of a code entered in the last 5 minutes, or null. Sensitive actions need it. */
  auth: FreshAuth | null;
}

/** What the login page needs: no session exists yet. Used ONLY by the public login entry points. */
export interface PublicContext {
  db: Db;
  env: AuthEnv | null;
  now: Date;
  client: ClientInfo;
  https: boolean;
  /** A valid session already exists (so /login can send the owner on). */
  signedIn: boolean;
}

async function readRequest() {
  await connection(); // only ever for a real request, never while `next build` prerenders
  const [h, c] = await Promise.all([headers(), cookies()]);
  return { h, c };
}

/** The session context, or null when there is no valid session (or auth is not configured). */
async function resolve(): Promise<GuardContext | null> {
  const { h, c } = await readRequest();
  let env: AuthEnv;
  try {
    env = getAuthEnv();
  } catch {
    return null; // fail closed: without a valid AUTH_SECRET nobody gets in
  }
  const https = isHttpsRequest(h, null, env.trustProxy);
  const token = readSessionToken(c, https);
  if (!token) return null;
  const db = getDb();
  const now = new Date();
  const session = verifySession(db, token, { env, now });
  if (!session) return null;
  return {
    db,
    session,
    env,
    now,
    client: clientInfoFromHeaders(h, env.trustProxy),
    https,
    auth: freshAuthFor(session, now),
  };
}

const toLogin = (): never => redirect('/login');

/** A server action. Refuses anyone without a valid session and any cross-site request. */
export function guardedAction<A extends unknown[], R>(
  fn: (ctx: GuardContext, ...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const { h } = await readRequest();
    if (!checkOrigin('POST', h).ok) throw new Error('Forbidden');
    const ctx = await resolve();
    if (!ctx) return toLogin();
    return fn(ctx, ...args);
  };
}

/** A route handler (route.ts). Answers 401 / 403 as JSON, never a redirect. */
export function guardedRoute<C>(
  fn: (ctx: GuardContext, request: Request, routeContext: C) => Promise<Response>,
): (request: Request, routeContext: C) => Promise<Response> {
  return async (request, routeContext) => {
    const origin = checkOrigin(request.method, request.headers);
    if (!origin.ok) return Response.json({ error: 'Forbidden' }, { status: 403 });
    const ctx = await resolve();
    if (!ctx) return Response.json({ error: 'Not signed in' }, { status: 401 });
    return fn(ctx, request, routeContext);
  };
}

/** For the page wrapper in guard.tsx. Redirects to /login when there is no valid session. */
export async function requireContext(): Promise<GuardContext> {
  return (await resolve()) ?? toLogin();
}

/**
 * Only the login entry points use this (the only public ones, listed in the coverage test): they
 * must work before a session exists.
 */
export async function publicContext(): Promise<PublicContext> {
  const { h, c } = await readRequest();
  let env: AuthEnv | null = null;
  try {
    env = getAuthEnv();
  } catch {
    env = null;
  }
  const trustProxy = env?.trustProxy ?? false;
  const https = isHttpsRequest(h, null, trustProxy);
  const db = getDb();
  const now = new Date();
  let signedIn = false;
  if (env) {
    const token = readSessionToken(c, https);
    signedIn = token ? verifySession(db, token, { env, now }) !== null : false;
  }
  return { db, env, now, client: clientInfoFromHeaders(h, trustProxy), https, signedIn };
}

/** The wrapper for the public login action: same Origin check, no session needed. */
export function publicAction<A extends unknown[], R>(
  fn: (ctx: PublicContext, ...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const { h } = await readRequest();
    if (!checkOrigin('POST', h).ok) throw new Error('Forbidden');
    return fn(await publicContext(), ...args);
  };
}

/**
 * Like requireFreshAuth, but returns null instead of throwing when no code was typed and none is
 * fresh. For actions that only sometimes need it (loosening a limit, using an override): the data
 * layer then decides, and refuses with StepUpRequiredError when it really was needed. A code that
 * was typed but is wrong is always an error.
 */
export function optionalFreshAuth(ctx: GuardContext, formData: FormData): FreshAuth | null {
  const typed = formData.get('stepUpCode');
  if (typeof typed === 'string' && typed.trim() !== '') {
    return requireFreshAuth(ctx, formData, 'a fresh authenticator code');
  }
  return ctx.auth;
}

/**
 * Step-up for a sensitive action. Accepts a code typed in the form (field "stepUpCode") or a code
 * entered within the last 5 minutes. Throws StepUpRequiredError otherwise.
 */
export function requireFreshAuth(
  ctx: GuardContext,
  formData: FormData | null,
  reason: string,
): FreshAuth {
  const typed = formData?.get('stepUpCode');
  if (typeof typed === 'string' && typed.trim() !== '') {
    const result = stepUp(ctx.db, ctx.session, typed, ctx.client, { env: ctx.env, now: ctx.now });
    if (result.ok) return result.auth;
    throw new StepUpRequiredError(
      result.reason === 'throttled'
        ? `too many attempts, wait ${Math.ceil(result.retryAfterMs / 1000)} seconds`
        : 'the code was not accepted',
    );
  }
  return assertFreshAuth(ctx.auth, ctx.now, reason);
}

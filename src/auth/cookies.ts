import 'server-only';
import type { HeaderReader } from './client';

/**
 * The session cookie.
 *
 * - HttpOnly (JavaScript cannot read it), SameSite=Strict (never sent on cross-site requests),
 *   Path=/, no Domain.
 * - Secure whenever the connection is HTTPS, and then the name gets the __Host- prefix (browsers
 *   then guarantee it came over HTTPS, from this exact host, for the whole site).
 * - On plain http://127.0.0.1 (your own computer) the prefix cannot be used, because __Host-
 *   requires Secure. The cookie then has the plain name and no Secure flag.
 * - Behind a reverse proxy (module 8) the proxy tells us about HTTPS with X-Forwarded-Proto, which
 *   is believed only when TRUST_PROXY=true.
 */

import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from './cookie-names';

export { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE };

export function isHttpsRequest(
  headers: HeaderReader,
  requestProtocol: string | null,
  trustProxy: boolean,
): boolean {
  if (requestProtocol === 'https:' || requestProtocol === 'https') return true;
  return (
    trustProxy &&
    (headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase() === 'https'
  );
}

export const sessionCookieName = (https: boolean) =>
  https ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;

export interface SessionCookieAttributes {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function sessionCookieAttributes(
  https: boolean,
  absoluteMs: number,
): SessionCookieAttributes {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: https,
    path: '/',
    maxAge: Math.floor(absoluteMs / 1000),
  };
}

/** Both names are read, so a session survives switching between the two. (A cookie from the other
 *  name can never be set by an attacker over HTTPS: __Host- cookies cannot be overwritten.) */
export function readSessionToken(
  cookies: { get(name: string): { value: string } | undefined },
  https: boolean,
): string | null {
  const preferred = cookies.get(sessionCookieName(https))?.value;
  if (preferred) return preferred;
  // Over HTTPS only the __Host- cookie is believed; a plain-name cookie could have been planted
  // by another (insecure) site on the same host name.
  return https ? null : (cookies.get(SESSION_COOKIE_PLAIN)?.value ?? null);
}

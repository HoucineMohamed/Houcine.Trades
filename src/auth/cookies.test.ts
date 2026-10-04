import { describe, expect, it } from 'vitest';
import {
  isHttpsRequest,
  readSessionToken,
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  sessionCookieAttributes,
  sessionCookieName,
} from './cookies';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const jar = (values: Record<string, string>) => ({
  get: (n: string) => (n in values ? { value: values[n]! } : undefined),
});

describe('session cookie', () => {
  it('uses the __Host- prefix exactly when the connection is HTTPS', () => {
    expect(sessionCookieName(true)).toBe('__Host-houcine_session');
    expect(sessionCookieName(false)).toBe('houcine_session');
  });

  it('flags: HttpOnly, SameSite=Strict, path /, Secure only on HTTPS, lifetime = the absolute lifetime', () => {
    expect(sessionCookieAttributes(true, 12 * 3600_000)).toEqual({
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/',
      maxAge: 43_200,
    });
    expect(sessionCookieAttributes(false, 3600_000)).toEqual({
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
      maxAge: 3600,
    });
  });

  it('HTTPS is detected from the real connection; X-Forwarded-Proto only counts when the proxy is trusted', () => {
    expect(isHttpsRequest(headers({}), 'https:', false)).toBe(true);
    expect(isHttpsRequest(headers({}), 'http:', false)).toBe(false);
    expect(isHttpsRequest(headers({ 'x-forwarded-proto': 'https' }), 'http:', false)).toBe(false); // spoofable: ignored
    expect(isHttpsRequest(headers({ 'x-forwarded-proto': 'https' }), 'http:', true)).toBe(true);
    expect(isHttpsRequest(headers({ 'x-forwarded-proto': 'http' }), 'http:', true)).toBe(false);
    expect(isHttpsRequest(headers({ 'x-forwarded-proto': 'HTTPS, http' }), null, true)).toBe(true);
  });

  it('over HTTPS only the __Host- cookie is believed (a plain-name cookie could be planted by an insecure page)', () => {
    expect(readSessionToken(jar({ [SESSION_COOKIE_SECURE]: 'a-token' }), true)).toBe('a-token');
    expect(readSessionToken(jar({ [SESSION_COOKIE_PLAIN]: 'planted' }), true)).toBeNull();
  });

  it('over plain http (your own computer) the plain cookie is used', () => {
    expect(readSessionToken(jar({ [SESSION_COOKIE_PLAIN]: 'a-token' }), false)).toBe('a-token');
    expect(readSessionToken(jar({}), false)).toBeNull();
    expect(readSessionToken(jar({}), true)).toBeNull();
  });
});

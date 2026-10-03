import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, checkOrigin, isPublicPath, securityHeaders } from '@/auth/request-checks';
import { SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from '@/auth/cookie-names';

/**
 * First, cheap line of defence. It is NOT the security boundary: every page, action and route
 * handler checks the real session itself (src/app/_lib/guard.ts, enforced by a test). This only
 * (1) refuses cross-site state-changing requests, (2) sends visitors without a session cookie to
 * /login, and (3) adds the security headers and the nonce-based Content-Security-Policy.
 *
 * Prefetch requests are NOT skipped: they need a session like any other request.
 */
export function proxy(request: NextRequest) {
  const https =
    request.nextUrl.protocol === 'https:' ||
    (process.env.TRUST_PROXY === 'true' &&
      (request.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https');

  const origin = checkOrigin(request.method, request.headers);
  if (!origin.ok) {
    return new NextResponse('Forbidden', { status: 403, headers: securityHeaders({ https }) });
  }

  const { pathname } = request.nextUrl;
  const hasCookie = request.cookies.has(https ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN);
  if (!isPublicPath(pathname) && !hasCookie) {
    // A relative Location: the browser stays on the host it used, nothing is built from headers.
    return new NextResponse(null, {
      status: 303,
      headers: { ...securityHeaders({ https }), Location: '/login' },
    });
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', https });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(securityHeaders({ https }))) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Static build files need no checks and no CSP. Everything else, prefetches included, does.
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};

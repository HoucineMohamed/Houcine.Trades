/**
 * Cheap, pure request checks used by src/proxy.ts (and tested on their own): the Origin/Host
 * check against cross-site request forgery, the security headers and the Content-Security-Policy.
 * No I/O and no secrets here.
 */

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

interface HeaderReader {
  get(name: string): string | null;
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

/**
 * CSRF defence, on top of the SameSite=Strict cookie. A state-changing request is allowed only if
 * the browser says it came from THIS site: the Origin header must name the same host as the Host
 * header. A missing or "null" Origin is refused (modern browsers always send it on POST), and so
 * is a Sec-Fetch-Site that says anything other than same-origin.
 */
export function checkOrigin(method: string, headers: HeaderReader): OriginVerdict {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return { ok: true };
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return { ok: false, reason: 'cross-site request' };
  }
  const origin = headers.get('origin');
  const host = headers.get('host');
  if (!origin || origin === 'null' || !host) return { ok: false, reason: 'missing origin' };
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, reason: 'invalid origin' };
  }
  return originHost.toLowerCase() === host.toLowerCase()
    ? { ok: true }
    : { ok: false, reason: 'origin does not match host' };
}

/** Only the login page, the health check and Next's own static files are reachable without a session. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname === '/healthz' || pathname.startsWith('/_next/static/');
}

export function buildCsp(nonce: string, options: { dev: boolean; https: boolean }): string {
  const directives = [
    `default-src 'self'`,
    // Scripts only with this request's nonce. Development needs 'unsafe-eval' (React debugging).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    // No inline styles at all: every style lives in the stylesheet.
    `style-src 'self'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (options.https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function securityHeaders(options: { https: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Everything past the proxy except Next's own static files is private.
    'Cache-Control': 'no-store',
  };
  if (options.https) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

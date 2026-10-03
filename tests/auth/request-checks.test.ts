import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { buildCsp, checkOrigin, isPublicPath, securityHeaders } from '@/auth/request-checks';
import { proxy } from '@/proxy';

const h = (o: Record<string, string>) => new Headers(o);

describe('Origin / Host check (CSRF)', () => {
  const host = '127.0.0.1:3000';
  it('lets safe methods through without an Origin', () => {
    expect(checkOrigin('GET', h({ host })).ok).toBe(true);
    expect(checkOrigin('HEAD', h({ host })).ok).toBe(true);
  });
  it('accepts a same-origin POST', () => {
    expect(
      checkOrigin('POST', h({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }))
        .ok,
    ).toBe(true);
  });
  it.each([
    ['another site', { origin: 'http://evil.example' }],
    ['a look-alike host', { origin: 'http://127.0.0.1:3000.evil.example' }],
    ['a different port', { origin: 'http://127.0.0.1:4000' }],
    ['a missing Origin', {}],
    ['a "null" Origin', { origin: 'null' }],
    ['garbage', { origin: 'not a url' }],
    ['a cross-site fetch', { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'cross-site' }],
    [
      'a same-site (sub-domain) fetch',
      { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' },
    ],
  ])('refuses %s', (_name, extra) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkOrigin(method, h({ host, ...extra })).ok).toBe(false);
    }
  });
  it('refuses when the Host header is missing', () => {
    expect(checkOrigin('POST', h({ origin: 'http://127.0.0.1:3000' })).ok).toBe(false);
  });
});

describe('public paths', () => {
  it('are only the login page and Next static files', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/_next/static/chunks/a.js')).toBe(true);
    for (const p of [
      '/',
      '/trades',
      '/login/x',
      '/loginx',
      '/_next/image',
      '/api/x',
      '/security',
    ]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});

describe('security headers and CSP', () => {
  it('CSP has no inline-script or inline-style allowance and forbids framing', () => {
    const csp = buildCsp('abc', { dev: false, https: false });
    expect(csp).toContain(`script-src 'self' 'nonce-abc' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self'`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain(`frame-ancestors 'none'`);
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain(`form-action 'self'`);
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
  it('development (and only development) allows eval; https upgrades requests', () => {
    expect(buildCsp('abc', { dev: true, https: false })).toContain('unsafe-eval');
    expect(buildCsp('abc', { dev: false, https: true })).toContain('upgrade-insecure-requests');
  });
  it('sends the standard headers; HSTS only over https', () => {
    const plain = securityHeaders({ https: false });
    expect(plain['X-Content-Type-Options']).toBe('nosniff');
    expect(plain['Referrer-Policy']).toBe('no-referrer');
    expect(plain['Cache-Control']).toBe('no-store');
    expect(plain['Permissions-Policy']).toContain('camera=()');
    expect(plain['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ https: true })['Strict-Transport-Security']).toContain('max-age=');
  });
});

describe('proxy.ts', () => {
  const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(url, { method: init.method ?? 'GET', headers: init.headers });

  it('sends a visitor with no session cookie to /login, even for a prefetch', () => {
    for (const headers of [{}, { 'next-router-prefetch': '1' }, { purpose: 'prefetch' }] as Record<
      string,
      string
    >[]) {
      const res = proxy(req('http://127.0.0.1:3000/trades', { headers }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/login');
    }
  });
  it('lets /login through with a CSP that has a fresh nonce each time', () => {
    const a = proxy(req('http://127.0.0.1:3000/login'));
    const b = proxy(req('http://127.0.0.1:3000/login'));
    expect(a.status).toBe(200);
    expect(a.headers.get('content-security-policy')).toMatch(/nonce-/);
    expect(a.headers.get('content-security-policy')).not.toBe(
      b.headers.get('content-security-policy'),
    );
  });
  it('lets a request that carries a session cookie through (the page checks it for real)', () => {
    const res = proxy(
      req('http://127.0.0.1:3000/trades', { headers: { cookie: 'houcine_session=abc' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
  it('refuses a cross-site POST with 403 before anything else', () => {
    const res = proxy(
      req('http://127.0.0.1:3000/login', {
        method: 'POST',
        headers: { origin: 'http://evil.example', host: '127.0.0.1:3000' },
      }),
    );
    expect(res.status).toBe(403);
  });
});

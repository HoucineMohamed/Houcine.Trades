import { describe, expect, it } from 'vitest';
import { clientInfoFromHeaders, GLOBAL_BUCKET, sourceBucket } from './client';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('who is calling (for rate limits and logs)', () => {
  it('ignores X-Forwarded-For unless the proxy is trusted (a visitor can send any value)', () => {
    expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': '1.2.3.4' }), false).ip).toBe(
      'direct',
    );
    expect(
      clientInfoFromHeaders(headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }), false).ip,
    ).toBe('direct');
  });

  it('behind a trusted proxy the RIGHTMOST entry (added by the proxy) is used, not what the visitor claimed', () => {
    expect(
      clientInfoFromHeaders(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), true).ip,
    ).toBe('203.0.113.9');
    expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': '2001:db8::1' }), true).ip).toBe(
      '2001:db8::1',
    );
  });

  it('garbage or missing values become "unknown" (never trusted text)', () => {
    for (const bad of ['<script>', 'a'.repeat(100), '1.2.3.4; DROP TABLE', '']) {
      expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': bad }), true).ip, bad).toBe(
        'unknown',
      );
    }
    expect(clientInfoFromHeaders(headers({}), true).ip).toBe('unknown');
  });

  it('cleans and shortens the user agent', () => {
    const ua = clientInfoFromHeaders(
      headers({ 'user-agent': 'Mozilla\r\n\u0000<b>' + 'x'.repeat(500) }),
      false,
    ).userAgent;
    expect(ua).not.toMatch(/[\r\n\u0000]/);
    expect(ua.length).toBe(200);
    expect(clientInfoFromHeaders(headers({}), false).userAgent).toBe('');
  });

  it('bucket names', () => {
    expect(sourceBucket({ ip: '1.2.3.4', userAgent: '' })).toBe('source:1.2.3.4');
    expect(GLOBAL_BUCKET).toBe('global');
  });
});

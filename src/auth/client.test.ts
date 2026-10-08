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

describe('a spoofed client address cannot dodge the per-source limit (hosted behind one platform proxy)', () => {
  // The platform APPENDS the connecting address to what the client sent, so only the LAST entry is trusted.
  it.each([
    ['one hop', '203.0.113.9', '203.0.113.9'],
    ['a forged first entry', '10.0.0.1, 203.0.113.9', '203.0.113.9'],
    ['many forged entries', '1.1.1.1,2.2.2.2 , 3.3.3.3,  203.0.113.9', '203.0.113.9'],
    ['a forged private address first', '127.0.0.1, 203.0.113.9', '203.0.113.9'],
    ['IPv6', '1.1.1.1, 2001:db8::7', '2001:db8::7'],
  ])('%s', (_n, xff, expected) => {
    expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': xff }), true).ip).toBe(expected);
  });

  it('other "client address" headers are never read, trusted or not', () => {
    const spoof = {
      'x-real-ip': '6.6.6.6',
      'true-client-ip': '6.6.6.6',
      'cf-connecting-ip': '6.6.6.6',
      'x-client-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
    };
    expect(clientInfoFromHeaders(headers(spoof), true).ip).toBe('unknown');
    expect(clientInfoFromHeaders(headers(spoof), false).ip).toBe('direct');
    expect(
      clientInfoFromHeaders(headers({ ...spoof, 'x-forwarded-for': '203.0.113.9' }), true).ip,
    ).toBe('203.0.113.9');
  });

  it('a forged last entry (a client talking to the app without the proxy) is only ever one source: its own claim', () => {
    // Without the platform proxy nobody can reach the app; this documents that the value is just a bucket key.
    expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': '6.6.6.6' }), true).ip).toBe(
      '6.6.6.6',
    );
  });

  it('a very long or odd-looking last entry is "unknown", never stored as text', () => {
    for (const bad of ['1.1.1.1, ' + 'a'.repeat(60), '1.1.1.1, <b>', '1.1.1.1, 2.2.2.2; x']) {
      expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': bad }), true).ip, bad).toBe(
        'unknown',
      );
    }
    // only the characters of an address are ever kept (a trailing comma just ends the list)
    expect(clientInfoFromHeaders(headers({ 'x-forwarded-for': '1.1.1.1,' }), true).ip).toBe(
      '1.1.1.1',
    );
  });
});

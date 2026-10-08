import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactValue } from './redact';

// secrets are built at run time: no key-looking literal in the repository
const rnd = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + n) % 36],
  ).join('');
const TOKEN = `${'1234567890'}:${rnd(35)}`;
const SECRET = `s3cr${rnd(12)}`;

describe('redactText', () => {
  it('removes URL credentials, paths and queries (a Telegram token sits in the path)', () => {
    const out = redactText(
      `fetch failed https://user:pw@api.telegram.org/bot${TOKEN}/sendMessage?x=1&sig=abc`,
    );
    expect(out).toBe('fetch failed https://api.telegram.org/…');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('pw');
  });
  it('removes bot tokens, bearer headers, AWS key ids, JWTs and long opaque strings', () => {
    const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const jwt = `eyJ${rnd(10)}.${rnd(10)}.${rnd(10)}`;
    const text = `a ${TOKEN} b Bearer ${rnd(20)} c ${aws} d ${jwt} e ${rnd(50)}`;
    const out = redactText(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(aws);
    expect(out).not.toContain(jwt);
    expect(out).not.toMatch(/[A-Za-z0-9]{32,}/);
  });
  it('removes key=value secrets', () => {
    expect(redactText('password=hunter2 and AUTH_TOKEN: abcdef12')).toBe(
      `password=${REDACTED} and AUTH_TOKEN=${REDACTED}`,
    );
  });
  it('removes exact secret values and their encodings, even short ones', () => {
    const b64 = Buffer.from(SECRET).toString('base64');
    const out = redactText(`x ${SECRET} y ${encodeURIComponent(SECRET + '/ ')} z ${b64}`, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(b64);
  });
  it('cuts long text', () => {
    expect(redactText('word '.repeat(200)).length).toBeLessThan(330);
  });
  it('leaves ordinary words alone', () => {
    expect(redactText('backup finished in 12 ms')).toBe('backup finished in 12 ms');
  });
});

describe('redactValue', () => {
  it('hides the whole value of sensitive keys, whatever the value', () => {
    const out = redactValue({
      cookie: 'a=b',
      Authorization: 'x',
      body: { note: 'my trade notes' },
      headers: { host: 'h' },
      sessionId: 1,
      backupKey: 'k',
      ok: 'fine',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      cookie: REDACTED,
      Authorization: REDACTED,
      body: REDACTED,
      headers: REDACTED,
      sessionId: REDACTED,
      backupKey: REDACTED,
      ok: 'fine',
    });
  });
  it('reduces errors to name and redacted message (no stack, no cause)', () => {
    const e = new TypeError(`failed https://api.telegram.org/bot${TOKEN}/x`);
    const out = redactValue(e) as { error: string; message: string };
    expect(out.error).toBe('TypeError');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
  it('is bounded: deep, long and odd values do not blow up', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[too deep]');
    expect(redactValue(() => 1)).toBe('[unsupported]');
    expect(redactValue(Number.NaN)).toBeNull();
    expect((redactValue(Array.from({ length: 500 }, (_, i) => i)) as number[]).length).toBe(40);
  });
});

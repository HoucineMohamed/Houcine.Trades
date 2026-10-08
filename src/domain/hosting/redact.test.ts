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

describe('redaction never lets a seeded secret through', () => {
  let seed = 4242;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SPECIAL = '.*+?^${}()|[]\\/-_!@#% ';
  const secretOf = (n: number, special: boolean) => {
    const chars = (special ? ALPHA + SPECIAL : ALPHA).split('');
    return Array.from({ length: n }, () => chars[Math.floor(rand() * chars.length)]).join('');
  };
  const FILLER = ['', ' ', 'x', 'error: ', '"', "'", '(', ')=', ',', '\n', 'a=b&c=', '/path/'];
  const forms = (s: string) => [
    s,
    encodeURIComponent(s),
    Buffer.from(s).toString('base64'),
    Buffer.from(s).toString('base64url'),
  ];
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)] as T;

  it('in text at random positions, in every encoding it claims to handle', () => {
    for (let i = 0; i < 400; i++) {
      const secret = secretOf(6 + Math.floor(rand() * 20), rand() < 0.5);
      const text = `${pick(FILLER)}${pick(FILLER)}${pick(forms(secret))}${pick(FILLER)}${pick(FILLER)}`;
      const out = redactText(text, [secret]);
      for (const f of forms(secret)) expect(out, JSON.stringify(text)).not.toContain(f);
    }
  });
  it('inside errors, nested values, arrays and JSON text', () => {
    for (let i = 0; i < 150; i++) {
      const secret = secretOf(8 + Math.floor(rand() * 12), false);
      for (const w of [
        new Error(`failed with ${secret}`),
        { a: { b: [`x ${secret} y`] } },
        [secret, { note: `v=${secret}` }],
        JSON.stringify({ v: secret }),
      ]) {
        expect(JSON.stringify(redactValue(w, [secret]))).not.toContain(secret);
      }
    }
  });
  it('a secret used as an object KEY does not reach the output', () => {
    const secret = secretOf(16, false);
    expect(JSON.stringify(redactValue({ [secret]: 1 }, [secret]))).not.toContain(secret);
  });
  it('secrets under 6 characters are ignored by design (documented limit)', () => {
    expect(redactText('abcde', ['abcde'])).toBe('abcde');
  });
});

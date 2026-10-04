import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { generateTotpSecret, stepAt, totpQr, totpUri, verifyTotp } from './totp';

/**
 * RFC 6238, Appendix B: the SHA-1 test vectors. The shared secret is the ASCII text
 * "12345678901234567890" (Base32 below). The RFC lists 8-digit codes; a 6-digit code is the last
 * 6 digits of the same number.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS: [seconds: number, code8: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('RFC 6238 test vectors', () => {
  it.each(RFC_VECTORS)('the library produces the RFC code for T=%i s', (seconds, code8) => {
    const code = TOTP.generate({
      secret: Secret.fromBase32(RFC_SECRET),
      digits: 8,
      period: 30,
      timestamp: seconds * 1000,
    });
    expect(code).toBe(code8);
  });

  it.each(RFC_VECTORS)(
    'our verifier accepts the 6-digit form at T=%i s, with the right step',
    (seconds, code8) => {
      const r = verifyTotp({
        secretBase32: RFC_SECRET,
        code: code8.slice(2),
        now: new Date(seconds * 1000),
        lastUsedStep: null,
      });
      expect(r).toEqual({ ok: true, step: Math.floor(seconds / 30) });
    },
  );
});

describe('drift, expiry and replay (fixed clock)', () => {
  const NOW = new Date(1234567890 * 1000); // RFC time: step 41152263, code ...005924
  const secret = generateTotpSecret();
  const codeFor = (offsetSteps: number) =>
    TOTP.generate({
      secret: Secret.fromBase32(secret),
      digits: 6,
      period: 30,
      timestamp: NOW.getTime() + offsetSteps * 30_000,
    });
  const check = (code: string, lastUsedStep: number | null = null, now = NOW) =>
    verifyTotp({ secretBase32: secret, code, now, lastUsedStep });

  it('the current code is accepted', () => {
    expect(check(codeFor(0))).toEqual({ ok: true, step: stepAt(NOW) });
  });

  it('one step of clock drift either way is accepted (30 s early or late)', () => {
    expect(check(codeFor(-1))).toEqual({ ok: true, step: stepAt(NOW) - 1 });
    expect(check(codeFor(1))).toEqual({ ok: true, step: stepAt(NOW) + 1 });
  });

  it('two steps away is refused (expired / too early)', () => {
    expect(check(codeFor(-2))).toEqual({ ok: false });
    expect(check(codeFor(2))).toEqual({ ok: false });
    expect(check(codeFor(-10))).toEqual({ ok: false });
  });

  it('a code expires: valid at its own time, refused 2 steps (60 s) later', () => {
    const code = codeFor(0);
    expect(check(code).ok).toBe(true);
    expect(check(code, null, new Date(NOW.getTime() + 60_000)).ok).toBe(false);
  });

  it('REPLAY: a code that was accepted once is never accepted again', () => {
    const code = codeFor(0);
    const first = check(code);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(check(code, first.step)).toEqual({ ok: false }); // same code again: refused
  });

  it('REPLAY: after step s was used, any code for an older step is refused too', () => {
    expect(check(codeFor(-1), stepAt(NOW))).toEqual({ ok: false });
    expect(check(codeFor(0), stepAt(NOW))).toEqual({ ok: false });
    expect(check(codeFor(1), stepAt(NOW))).toEqual({ ok: true, step: stepAt(NOW) + 1 }); // the NEXT code works
  });

  it('a code for an older step is fine if nothing newer was used yet', () => {
    expect(check(codeFor(-1), stepAt(NOW) - 2)).toEqual({ ok: true, step: stepAt(NOW) - 1 });
  });

  it('wrong codes, wrong secret and malformed input are refused without throwing', () => {
    const good = codeFor(0);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    for (const bad of [wrong, '', ' ', '12345', '1234567', 'abcdef', '12345a', '١٢٣٤٥٦']) {
      expect(check(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
    expect(
      verifyTotp({ secretBase32: generateTotpSecret(), code: good, now: NOW, lastUsedStep: null }),
    ).toEqual({ ok: false });
    expect(
      verifyTotp({ secretBase32: '!!!not base32!!!', code: good, now: NOW, lastUsedStep: null }),
    ).toEqual({ ok: false });
  });

  it('spaces inside the code are ignored (apps display "123 456")', () => {
    const c = codeFor(0);
    expect(check(`${c.slice(0, 3)} ${c.slice(3)}`).ok).toBe(true);
  });
});

describe('enrolment helpers', () => {
  it('secrets are random 160-bit Base32', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it('the otpauth link carries the standard parameters', () => {
    const secret = generateTotpSecret();
    const uri = totpUri(secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Houcine\.Trades:owner\?/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Houcine.Trades');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });

  it('draws a QR code for the terminal', () => {
    const qr = totpQr(totpUri(generateTotpSecret()));
    expect(qr.split('\n').length).toBeGreaterThan(10);
    expect(qr.length).toBeGreaterThan(200);
  });
});

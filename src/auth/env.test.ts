import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_SECRET_MIN_LENGTH, AuthEnvError, parseAuthEnv } from './env';

// Generated at run time, so no secret-looking literal exists in the repository.
const goodSecret = () => randomBytes(48).toString('base64url');

describe('AUTH_SECRET and session settings', () => {
  it('accepts a random secret and applies the defaults (2 h idle, 12 h absolute, proxy not trusted)', () => {
    const secret = goodSecret();
    const env = parseAuthEnv({ AUTH_SECRET: secret });
    expect(env.secret).toBe(secret);
    expect(env.session).toEqual({ idleMs: 2 * 3600_000, absoluteMs: 12 * 3600_000 });
    expect(env.trustProxy).toBe(false);
  });

  it('rejects a missing, short, placeholder or low-variety secret, without echoing it', () => {
    const cases: [string | undefined, RegExp][] = [
      [undefined, /AUTH_SECRET is missing/],
      ['', /at least 32/],
      ['x'.repeat(AUTH_SECRET_MIN_LENGTH - 1), /at least 32/],
      ['replace-with-the-output-of-the-generate-command-see-docs-security', /placeholder/],
      ['please-change-me-please-change-me-please-change-me', /placeholder/],
      ['your-secret-goes-here-your-secret-goes-here-1234', /placeholder/],
      ['a'.repeat(64), /not random enough/],
      ['abababababababababababababababababababab', /not random enough/],
    ];
    for (const [value, message] of cases) {
      expect(() => parseAuthEnv({ AUTH_SECRET: value }), String(value)).toThrow(AuthEnvError);
      try {
        parseAuthEnv({ AUTH_SECRET: value });
      } catch (e) {
        expect((e as Error).message).toMatch(message);
        if (value && value.length > 8) expect((e as Error).message).not.toContain(value);
      }
    }
  });

  it('session times: bounds are enforced', () => {
    const base = { AUTH_SECRET: goodSecret() };
    expect(
      parseAuthEnv({ ...base, SESSION_IDLE_MINUTES: '5', SESSION_ABSOLUTE_HOURS: '1' }).session,
    ).toEqual({ idleMs: 300_000, absoluteMs: 3_600_000 });
    expect(
      parseAuthEnv({ ...base, SESSION_IDLE_MINUTES: '480', SESSION_ABSOLUTE_HOURS: '72' }).session
        .idleMs,
    ).toBe(480 * 60_000);
    for (const bad of [
      { SESSION_IDLE_MINUTES: '4' },
      { SESSION_IDLE_MINUTES: '481' },
      { SESSION_ABSOLUTE_HOURS: '0' },
      { SESSION_ABSOLUTE_HOURS: '73' },
      { SESSION_IDLE_MINUTES: 'two' },
      { SESSION_IDLE_MINUTES: '1.5' },
      { SESSION_ABSOLUTE_HOURS: '-1' },
    ]) {
      expect(() => parseAuthEnv({ ...base, ...bad }), JSON.stringify(bad)).toThrow(AuthEnvError);
    }
  });

  it('the idle timeout can never be longer than the absolute lifetime', () => {
    expect(() =>
      parseAuthEnv({
        AUTH_SECRET: goodSecret(),
        SESSION_IDLE_MINUTES: '180',
        SESSION_ABSOLUTE_HOURS: '2',
      }),
    ).toThrow(/cannot be longer/);
  });

  it('TRUST_PROXY is true or false only', () => {
    const base = { AUTH_SECRET: goodSecret() };
    expect(parseAuthEnv({ ...base, TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true);
    expect(parseAuthEnv({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(() => parseAuthEnv({ ...base, TRUST_PROXY: 'yes' })).toThrow(AuthEnvError);
  });
});

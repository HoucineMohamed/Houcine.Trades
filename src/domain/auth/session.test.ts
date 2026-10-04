import { describe, expect, it } from 'vitest';
import { checkSessionTimes, shouldTouch, TOUCH_INTERVAL_MS } from './session';

const TIMES = { idleMs: 2 * 3600_000, absoluteMs: 12 * 3600_000 };
const created = '2026-03-10T08:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('session lifetime', () => {
  it('valid while recently used and young', () => {
    expect(
      checkSessionTimes(created, '2026-03-10T09:30:00.000Z', at('2026-03-10T10:00:00.000Z'), TIMES),
    ).toEqual({ valid: true });
  });

  it('idle timeout: 1 ms before is valid, exactly at 2 hours is over', () => {
    const seen = '2026-03-10T09:00:00.000Z';
    expect(checkSessionTimes(created, seen, at('2026-03-10T10:59:59.999Z'), TIMES).valid).toBe(
      true,
    );
    expect(checkSessionTimes(created, seen, at('2026-03-10T11:00:00.000Z'), TIMES)).toEqual({
      valid: false,
      reason: 'idle',
    });
  });

  it('absolute lifetime: a busy session still ends 12 hours after login', () => {
    const seen = '2026-03-10T19:59:00.000Z'; // used a minute ago
    expect(checkSessionTimes(created, seen, at('2026-03-10T19:59:59.999Z'), TIMES).valid).toBe(
      true,
    );
    expect(checkSessionTimes(created, seen, at('2026-03-10T20:00:00.000Z'), TIMES)).toEqual({
      valid: false,
      reason: 'absolute',
    });
  });

  it('fails closed on unreadable times', () => {
    expect(checkSessionTimes('nonsense', created, at(created), TIMES)).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(checkSessionTimes(created, '', at(created), TIMES)).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(checkSessionTimes(created, created, new Date('x'), TIMES)).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('last-seen is only saved about once a minute', () => {
    const seen = '2026-03-10T09:00:00.000Z';
    expect(shouldTouch(seen, at('2026-03-10T09:00:59.999Z'))).toBe(false);
    expect(shouldTouch(seen, new Date(new Date(seen).getTime() + TOUCH_INTERVAL_MS))).toBe(true);
    expect(shouldTouch('garbage', at(seen))).toBe(true);
  });
});

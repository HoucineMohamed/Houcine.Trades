import { describe, expect, it } from 'vitest';
import {
  combineThrottles,
  delayAfterFailures,
  evaluateThrottle,
  GLOBAL_THROTTLE,
  SOURCE_THROTTLE,
} from './throttle';

const S = 1000;
const NOW = 1_000_000_000_000;

describe('delay schedule (per source: 4 free failures, then 5 s doubling, capped at 15 minutes)', () => {
  it('the first four failures are free', () => {
    for (const n of [0, 1, 2, 3, 4]) expect(delayAfterFailures(n, SOURCE_THROTTLE)).toBe(0);
  });

  it('then 5 s, 10 s, 20 s, 40 s, ...', () => {
    expect([5, 6, 7, 8, 9].map((n) => delayAfterFailures(n, SOURCE_THROTTLE))).toEqual([
      5 * S,
      10 * S,
      20 * S,
      40 * S,
      80 * S,
    ]);
    // 5 s x 2^7 = 640 s at the 12th failure
    expect(delayAfterFailures(12, SOURCE_THROTTLE)).toBe(640 * S);
  });

  it('is capped at 15 minutes (never grows forever: no permanent lockout)', () => {
    expect(delayAfterFailures(13, SOURCE_THROTTLE)).toBe(900 * S);
    for (const n of [14, 50, 1000, 1e9])
      expect(delayAfterFailures(n, SOURCE_THROTTLE)).toBe(900 * S);
    expect(delayAfterFailures(Number.MAX_SAFE_INTEGER, SOURCE_THROTTLE)).toBe(900 * S);
  });

  it('the global bucket allows 20 free failures and caps at 5 minutes', () => {
    expect(delayAfterFailures(20, GLOBAL_THROTTLE)).toBe(0);
    expect(delayAfterFailures(21, GLOBAL_THROTTLE)).toBe(5 * S);
    expect(delayAfterFailures(1000, GLOBAL_THROTTLE)).toBe(300 * S);
  });

  it('rejects nonsense input safely', () => {
    expect(delayAfterFailures(-3, SOURCE_THROTTLE)).toBe(0);
    expect(delayAfterFailures(2.5, SOURCE_THROTTLE)).toBe(0);
    expect(delayAfterFailures(Number.NaN, SOURCE_THROTTLE)).toBe(0);
  });
});

describe('evaluateThrottle', () => {
  const failures = (n: number, lastAgoMs: number) =>
    Array.from({ length: n }, (_, i) => NOW - lastAgoMs - (n - 1 - i) * S);

  it('not blocked with no failures or only free ones', () => {
    expect(evaluateThrottle([], NOW, SOURCE_THROTTLE)).toEqual({ blocked: false, retryAfterMs: 0 });
    expect(evaluateThrottle(failures(4, 0), NOW, SOURCE_THROTTLE).blocked).toBe(false);
  });

  it('the 5th failure blocks for 5 s: 1 ms before blocked, exactly at the end not blocked', () => {
    const f = failures(5, 0); // last failure at NOW
    expect(evaluateThrottle(f, NOW, SOURCE_THROTTLE)).toEqual({
      blocked: true,
      retryAfterMs: 5 * S,
    });
    expect(evaluateThrottle(f, NOW + 5 * S - 1, SOURCE_THROTTLE)).toEqual({
      blocked: true,
      retryAfterMs: 1,
    });
    expect(evaluateThrottle(f, NOW + 5 * S, SOURCE_THROTTLE)).toEqual({
      blocked: false,
      retryAfterMs: 0,
    });
  });

  it('the wait is counted from the LAST processed failure', () => {
    const f = failures(6, 20 * S); // 6 failures, the last 20 s ago -> delay 10 s -> already over
    expect(evaluateThrottle(f, NOW, SOURCE_THROTTLE).blocked).toBe(false);
    const g = failures(6, 4 * S); // last 4 s ago -> 6 s remain
    expect(evaluateThrottle(g, NOW, SOURCE_THROTTLE)).toEqual({
      blocked: true,
      retryAfterMs: 6 * S,
    });
  });

  it('failures older than the 1 hour window no longer count', () => {
    const old = failures(30, 61 * 60 * S);
    expect(evaluateThrottle(old, NOW, SOURCE_THROTTLE)).toEqual({
      blocked: false,
      retryAfterMs: 0,
    });
    // 5 failures: 3 of them old (ignored), 2 recent -> only 2 count -> free
    const mixed = [
      NOW - 3 * 3600 * S,
      NOW - 3 * 3600 * S,
      NOW - 3 * 3600 * S,
      NOW - 2 * S,
      NOW - S,
    ];
    expect(evaluateThrottle(mixed, NOW, SOURCE_THROTTLE).blocked).toBe(false);
  });

  it('NO PERMANENT LOCKOUT: however many failures, the wait is at most the cap and always ends', () => {
    const f = failures(5000, 0);
    const state = evaluateThrottle(f, NOW, SOURCE_THROTTLE);
    expect(state.retryAfterMs).toBeLessThanOrEqual(900 * S);
    expect(evaluateThrottle(f, NOW + 900 * S, SOURCE_THROTTLE).blocked).toBe(false);
  });

  it('ignores timestamps from the future and unordered input', () => {
    expect(
      evaluateThrottle(
        [NOW + 10 * S, NOW + 20 * S, NOW + 30 * S, NOW + 40 * S, NOW + 50 * S],
        NOW,
        SOURCE_THROTTLE,
      ).blocked,
    ).toBe(false);
    expect(
      evaluateThrottle([NOW, NOW - 4 * S, NOW - 2 * S, NOW - 3 * S, NOW - S], NOW, SOURCE_THROTTLE)
        .retryAfterMs,
    ).toBe(5 * S);
  });

  it('combining takes the longer wait', () => {
    expect(
      combineThrottles({ blocked: true, retryAfterMs: 5 }, { blocked: true, retryAfterMs: 9 }),
    ).toEqual({ blocked: true, retryAfterMs: 9 });
    expect(
      combineThrottles({ blocked: false, retryAfterMs: 0 }, { blocked: false, retryAfterMs: 0 })
        .blocked,
    ).toBe(false);
  });
});

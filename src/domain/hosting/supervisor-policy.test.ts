import { describe, expect, it } from 'vitest';
import { CRASH_POLICY, decideAfterCrash } from './supervisor-policy';

describe('crash policy', () => {
  it('restarts with a growing delay, capped', () => {
    let times: number[] = [];
    const delays: number[] = [];
    for (let i = 0; i < CRASH_POLICY.maxCrashes - 1; i++) {
      const r = decideAfterCrash(times, i * 10_000);
      times = r.crashTimes;
      expect(r.decision.action).toBe('restart');
      if (r.decision.action === 'restart') delays.push(r.decision.delayMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });
  it('gives up after maxCrashes inside the window', () => {
    let times: number[] = [];
    let last = decideAfterCrash(times, 0);
    for (let i = 1; i < CRASH_POLICY.maxCrashes; i++) {
      times = last.crashTimes;
      last = decideAfterCrash(times, i * 1000);
    }
    expect(last.decision).toEqual({ action: 'give_up' });
  });
  it('crashes outside the window are forgotten', () => {
    const old = [0, 1000, 2000, 3000];
    const r = decideAfterCrash(old, CRASH_POLICY.windowMs + 10_000);
    expect(r.decision).toEqual({ action: 'restart', delayMs: 1000 });
    expect(r.crashTimes).toEqual([CRASH_POLICY.windowMs + 10_000]);
  });
  it('never waits longer than the cap', () => {
    const r = decideAfterCrash([], 0, { ...CRASH_POLICY, baseDelayMs: 100_000 });
    expect(r.decision).toEqual({ action: 'restart', delayMs: CRASH_POLICY.maxDelayMs });
  });
});

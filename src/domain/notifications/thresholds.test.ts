import { describe, expect, it } from 'vitest';
import {
  baselineLimitState,
  COOLDOWN_MS,
  levelFromCap,
  levelFromShare,
  parseLimitState,
  stepLimit,
  utcDayKey,
  utcMonthKey,
  type Level,
  type LimitState,
} from './thresholds';

const T0 = new Date('2026-03-10T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('levelFromShare (the engine usage figures)', () => {
  it.each([
    ['0', false, 0],
    ['49.99', false, 0],
    ['50.00', false, 50],
    ['79.99', false, 50],
    ['80.00', false, 80],
    ['99.99', false, 80],
    ['100.00', true, 100],
    ['120', true, 100],
  ] as const)('share %s reached=%s -> %s', (share, reached, level) => {
    expect(levelFromShare(share, reached)).toBe(level);
  });
  it('reached wins even when the share is missing; unknown stays unknown', () => {
    expect(levelFromShare(null, true)).toBe(100);
    expect(levelFromShare(null, null)).toBeNull();
    expect(levelFromShare('abc', null)).toBeNull();
  });
  it('a rounded-up 100.00 that is not really reached counts as 80, not 100', () => {
    expect(levelFromShare('100.00', false)).toBe(80);
  });
});

describe('levelFromCap (exact)', () => {
  it.each([
    [0, 20, 0],
    [9, 20, 0],
    [10, 20, 50],
    [15, 20, 50],
    [16, 20, 80],
    [19, 20, 80],
    [20, 20, 100],
    [25, 20, 100],
    ['2.5', '5', 50],
    ['3.999999', '5', 50],
    ['4', '5', 80],
    ['5', '5', 100],
  ] as const)('%s of %s -> %s', (used, cap, level) => {
    expect(levelFromCap(used, cap)).toBe(level);
  });
  it('is null for a cap of 0 or unreadable numbers', () => {
    expect(levelFromCap(1, 0)).toBeNull();
    expect(levelFromCap('x', 5)).toBeNull();
    expect(levelFromCap(1, '')).toBeNull();
  });
});

describe('stepLimit', () => {
  const run = (prev: LimitState | null, level: Level | null, now = T0, period = '2026-03-10') =>
    stepLimit(prev, level, period, 'limit:daily_loss:1', now);

  it('announces a first crossing once, with a dedupe key naming period, epoch and level', () => {
    const a = run(null, 50);
    expect(a.announce).toEqual({ level: 50, dedupeKey: 'limit:daily_loss:1:2026-03-10:0:50' });
    expect(a.state.level).toBe(50);
    expect(run(a.state, 50, later(1000)).announce).toBeNull(); // same level again: nothing
  });
  it('announces only the highest level when usage jumps', () => {
    expect(run(null, 80).announce?.level).toBe(80);
    expect(run(null, 100).announce?.level).toBe(100);
  });
  it('announces each higher level once, in turn', () => {
    const a = run(null, 50);
    const b = run(a.state, 80, later(1000));
    const c = run(b.state, 100, later(2000));
    expect([a, b, c].map((x) => x.announce?.level)).toEqual([50, 80, 100]);
  });
  it('is quiet while usage falls, and announces again after it falls and rises (new epoch) past the cooldown', () => {
    const up = run(null, 80);
    const down = run(up.state, 0, later(1000));
    expect(down.announce).toBeNull();
    expect(down.state.epoch).toBe(1);
    const again = run(down.state, 80, later(COOLDOWN_MS + 1000));
    expect(again.announce).toEqual({ level: 80, dedupeKey: 'limit:daily_loss:1:2026-03-10:1:80' });
  });
  it('never repeats the same level within the one-hour cooldown (the state still moves)', () => {
    const up = run(null, 80);
    const down = run(up.state, 50, later(1000));
    const again = run(down.state, 80, later(COOLDOWN_MS - 1));
    expect(again.announce).toBeNull();
    expect(again.state.level).toBe(80);
  });
  it('a new period (a new UTC day) starts again from zero', () => {
    const up = run(null, 100);
    const next = run(up.state, 50, later(86_400_000), '2026-03-11');
    expect(next.announce).toEqual({ level: 50, dedupeKey: 'limit:daily_loss:1:2026-03-11:0:50' });
  });
  it('an unverifiable reading changes nothing', () => {
    const up = run(null, 80);
    const unknown = run(up.state, null, later(1000));
    expect(unknown.announce).toBeNull();
    expect(unknown.state).toEqual(up.state);
  });
  it('does not mutate the previous state', () => {
    const up = run(null, 80);
    const copy = JSON.stringify(up.state);
    run(up.state, 100, later(5000));
    expect(JSON.stringify(up.state)).toBe(copy);
  });
});

describe('state helpers', () => {
  it('baseline starts at the level seen when alerts are switched on (nothing old is announced)', () => {
    const base = baselineLimitState(80, '2026-03-10');
    expect(stepLimit(base, 80, '2026-03-10', 'k', T0).announce).toBeNull();
    expect(stepLimit(base, 100, '2026-03-10', 'k', T0).announce?.level).toBe(100);
    expect(baselineLimitState(null, 'p').level).toBe(0);
  });
  it('parses stored state strictly', () => {
    const s = baselineLimitState(50, 'p');
    expect(parseLimitState(JSON.stringify(s))).toEqual(s);
    expect(parseLimitState('{"level":7}')).toBeNull();
    expect(parseLimitState('nope')).toBeNull();
    expect(parseLimitState(null)).toBeNull();
  });
  it('period keys', () => {
    expect(utcDayKey(new Date('2026-03-10T23:59:59.999Z'))).toBe('2026-03-10');
    expect(utcMonthKey(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
  });
});

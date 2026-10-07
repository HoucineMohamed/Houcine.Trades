import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import {
  AI_CAP_CEILINGS,
  AI_CAP_DEFAULTS,
  AI_LOOSEN_DELAY_MS,
  checkCaps,
  nextUtcMonthStart,
  parseCaps,
  parseCapsJson,
  parsePendingCapsJson,
  requestCapsChange,
  settleCaps,
  utcMonthStart,
  type AiCaps,
  type UsageTotals,
} from './caps';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const usage = (p: Partial<UsageTotals> = {}): UsageTotals => ({
  callsToday: 0,
  callsThisMonth: 0,
  costThisMonthUsd: '0',
  ...p,
});

describe('defaults and ceilings', () => {
  it('match the approved numbers', () => {
    expect(AI_CAP_DEFAULTS).toEqual({ dailyCalls: 20, monthlyCalls: 200, monthlyCostUsd: '5' });
    expect(AI_CAP_CEILINGS).toEqual({ dailyCalls: 100, monthlyCalls: 1000, monthlyCostUsd: '25' });
  });
  it('the defaults are valid', () => {
    expect(parseCaps(AI_CAP_DEFAULTS).ok).toBe(true);
  });
});

describe('parseCaps (fails closed)', () => {
  it('rejects values above a ceiling, zero, junk, extra keys and missing keys', () => {
    for (const bad of [
      { ...AI_CAP_DEFAULTS, dailyCalls: 101 },
      { ...AI_CAP_DEFAULTS, monthlyCalls: 1001 },
      { ...AI_CAP_DEFAULTS, monthlyCostUsd: '25.01' },
      { ...AI_CAP_DEFAULTS, dailyCalls: 0 },
      { ...AI_CAP_DEFAULTS, dailyCalls: 1.5 },
      { ...AI_CAP_DEFAULTS, monthlyCostUsd: 'abc' },
      { ...AI_CAP_DEFAULTS, monthlyCostUsd: '-1' },
      { ...AI_CAP_DEFAULTS, extra: 1 },
      { dailyCalls: 5 },
      null,
      'x',
    ]) {
      expect(parseCaps(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('allows exactly the ceiling', () => {
    expect(parseCaps({ dailyCalls: 100, monthlyCalls: 1000, monthlyCostUsd: '25' }).ok).toBe(true);
  });
  it('treats missing or unreadable stored JSON as a problem', () => {
    expect(parseCapsJson(null).ok).toBe(false);
    expect(parseCapsJson('{nope').ok).toBe(false);
    expect(parseCapsJson(JSON.stringify(AI_CAP_DEFAULTS)).ok).toBe(true);
  });
});

describe('changing caps: tighten now, loosen after 24 hours', () => {
  const active: AiCaps = { dailyCalls: 20, monthlyCalls: 200, monthlyCostUsd: '5' };

  it('applies a lower value at once', () => {
    const r = requestCapsChange(active, {}, { dailyCalls: 10, monthlyCostUsd: '2.5' }, NOW);
    expect(r.active).toEqual({ dailyCalls: 10, monthlyCalls: 200, monthlyCostUsd: '2.5' });
    expect(r.applied).toHaveLength(2);
    expect(r.deferred).toEqual([]);
  });

  it('queues a higher value for 24 hours and leaves the active cap alone', () => {
    const r = requestCapsChange(active, {}, { monthlyCostUsd: '10' }, NOW);
    expect(r.active.monthlyCostUsd).toBe('5');
    expect(r.deferred).toEqual([
      {
        field: 'monthlyCostUsd',
        value: '10',
        effectiveAt: new Date(NOW.getTime() + AI_LOOSEN_DELAY_MS).toISOString(),
      },
    ]);
  });

  it('keeps the original timer when the same loosening is requested again', () => {
    const first = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const later = new Date(NOW.getTime() + 3_600_000);
    const again = requestCapsChange(active, first.pending, { dailyCalls: 50 }, later);
    expect(again.deferred[0]?.effectiveAt).toBe(first.deferred[0]?.effectiveAt);
  });

  it('a tighter or equal value cancels a pending loosening', () => {
    const first = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const back = requestCapsChange(active, first.pending, { dailyCalls: 20 }, NOW);
    expect(back.cancelled).toEqual(['dailyCalls']);
    expect(back.pending).toEqual({});
  });

  it('rejects a value above the ceiling (nothing is applied or queued)', () => {
    expect(() => requestCapsChange(active, {}, { dailyCalls: 101 }, NOW)).toThrow(ValidationError);
    expect(() => requestCapsChange(active, {}, { bogus: 1 } as never, NOW)).toThrow(
      ValidationError,
    );
  });

  it('settles a pending change exactly at its effective time, not before', () => {
    const r = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const at = new Date(NOW.getTime() + AI_LOOSEN_DELAY_MS);
    expect(settleCaps(active, r.pending, new Date(at.getTime() - 1)).caps.dailyCalls).toBe(20);
    const done = settleCaps(active, r.pending, at);
    expect(done.caps.dailyCalls).toBe(50);
    expect(done.stillPending).toEqual({});
    expect(done.becameEffective).toHaveLength(1);
  });

  it('rejects corrupt pending JSON', () => {
    expect(
      parsePendingCapsJson('{"dailyCalls":{"value":500,"requestedAt":"a","effectiveAt":"b"}}').ok,
    ).toBe(false);
    expect(parsePendingCapsJson('{"nope":1}').ok).toBe(false);
    expect(parsePendingCapsJson('[]').ok).toBe(false);
    expect(parsePendingCapsJson('').ok).toBe(true);
  });
});

describe('checkCaps', () => {
  const caps = AI_CAP_DEFAULTS;

  it('allows a request inside every cap', () => {
    expect(checkCaps(caps, usage({ callsToday: 19 }), '0.05', NOW).allowed).toBe(true);
  });
  it('stops at the daily cap (exactly at the limit is the 21st call)', () => {
    const r = checkCaps(caps, usage({ callsToday: 20 }), '0.05', NOW);
    expect(r).toMatchObject({
      allowed: false,
      code: 'DAILY_CALLS',
      resetsAt: '2026-03-11T00:00:00.000Z',
    });
  });
  it('stops at the monthly call cap, resetting on the 1st', () => {
    const r = checkCaps(caps, usage({ callsThisMonth: 200 }), '0.05', NOW);
    expect(r).toMatchObject({
      allowed: false,
      code: 'MONTHLY_CALLS',
      resetsAt: '2026-04-01T00:00:00.000Z',
    });
  });
  it('stops when the worst-case cost would pass the monthly cost cap, but allows exactly at it', () => {
    expect(checkCaps(caps, usage({ costThisMonthUsd: '4.95' }), '0.05', NOW).allowed).toBe(true);
    const over = checkCaps(caps, usage({ costThisMonthUsd: '4.951' }), '0.05', NOW);
    expect(over).toMatchObject({ allowed: false, code: 'MONTHLY_COST' });
  });
  it('fails closed on unreadable totals', () => {
    expect(checkCaps(caps, usage({ callsToday: Number.NaN }), '0.05', NOW).allowed).toBe(false);
    expect(checkCaps(caps, usage({ costThisMonthUsd: 'oops' }), '0.05', NOW).allowed).toBe(false);
    expect(checkCaps(caps, usage(), 'oops', NOW).allowed).toBe(false);
    expect(checkCaps(caps, usage({ callsToday: -1 }), '0.05', NOW).allowed).toBe(false);
  });
  it('rolls the month over in December', () => {
    const dec = new Date('2026-12-31T23:59:00.000Z');
    expect(checkCaps(caps, usage({ callsThisMonth: 200 }), '0', dec)).toMatchObject({
      resetsAt: '2027-01-01T00:00:00.000Z',
    });
  });
});

describe('caps: more rules of the pending timer', () => {
  const active: AiCaps = { dailyCalls: 20, monthlyCalls: 200, monthlyCostUsd: '5' };
  const LATER = new Date(NOW.getTime() + 3_600_000);

  it('a different looser value replaces the pending one and restarts the 24 hours', () => {
    const first = requestCapsChange(active, {}, { dailyCalls: 30 }, NOW);
    const second = requestCapsChange(active, first.pending, { dailyCalls: 40 }, LATER);
    expect(second.pending.dailyCalls?.value).toBe(40);
    expect(second.pending.dailyCalls?.effectiveAt).toBe(
      new Date(LATER.getTime() + AI_LOOSEN_DELAY_MS).toISOString(),
    );
  });
  it('a lower (but still looser) value also replaces it', () => {
    const first = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const second = requestCapsChange(active, first.pending, { dailyCalls: 30 }, LATER);
    expect(second.pending.dailyCalls?.value).toBe(30);
  });
  it('a tightening cancels the pending value', () => {
    const first = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const t = requestCapsChange(active, first.pending, { dailyCalls: 10 }, NOW);
    expect(t.cancelled).toEqual(['dailyCalls']);
    expect(t.active.dailyCalls).toBe(10);
    expect(t.pending).toEqual({});
  });
  it('the same cost written differently keeps the timer', () => {
    const first = requestCapsChange(active, {}, { monthlyCostUsd: '10' }, NOW);
    const again = requestCapsChange(active, first.pending, { monthlyCostUsd: '10.0' }, LATER);
    expect(again.deferred[0]?.effectiveAt).toBe(first.deferred[0]?.effectiveAt);
  });
  it('a mixed request reports every outcome at once', () => {
    const base = requestCapsChange(active, {}, { monthlyCalls: 300 }, NOW); // pending
    const r = requestCapsChange(
      active,
      base.pending,
      { dailyCalls: 10, monthlyCalls: 200, monthlyCostUsd: '6' },
      LATER,
    );
    expect(r.applied.map((a) => a.field)).toEqual(['dailyCalls']);
    expect(r.cancelled).toEqual(['monthlyCalls']); // equal to active: cancels the pending 300
    expect(r.deferred.map((d) => d.field)).toEqual(['monthlyCostUsd']);
  });
  it('settles only the fields that are due', () => {
    const a = requestCapsChange(active, {}, { dailyCalls: 50 }, NOW);
    const b = requestCapsChange(active, a.pending, { monthlyCalls: 300 }, LATER);
    const s = settleCaps(active, b.pending, new Date(NOW.getTime() + AI_LOOSEN_DELAY_MS));
    expect(s.caps.dailyCalls).toBe(50);
    expect(s.caps.monthlyCalls).toBe(200);
    expect(Object.keys(s.stillPending)).toEqual(['monthlyCalls']);
  });
});

describe('cost cap values', () => {
  it.each([
    ['25', true],
    ['25.000001', false],
    ['0', false],
    ['-1', false],
    ['1e1', false],
    [' 5 ', true],
    ['05', true],
    ['5.0', true],
    ['', false],
  ])('%j accepted: %s', (value, ok) => {
    expect(parseCaps({ ...AI_CAP_DEFAULTS, monthlyCostUsd: value }).ok).toBe(ok);
  });
  it('is normalised (5.0 and 05 become 5)', () => {
    const r = parseCaps({ ...AI_CAP_DEFAULTS, monthlyCostUsd: '05.0' });
    expect(r.ok && r.caps.monthlyCostUsd).toBe('5');
  });
  it('call caps need whole numbers from 1 to the ceiling, not strings', () => {
    expect(parseCaps({ ...AI_CAP_DEFAULTS, dailyCalls: 1 }).ok).toBe(true);
    expect(parseCaps({ ...AI_CAP_DEFAULTS, dailyCalls: 0 }).ok).toBe(false);
    expect(parseCaps({ ...AI_CAP_DEFAULTS, dailyCalls: '5' }).ok).toBe(false);
  });
});

describe('checkCaps order and edges', () => {
  it('reports the daily cap first when several are exceeded', () => {
    const r = checkCaps(
      AI_CAP_DEFAULTS,
      { callsToday: 20, callsThisMonth: 200, costThisMonthUsd: '5' },
      '1',
      NOW,
    );
    expect(r).toMatchObject({ allowed: false, code: 'DAILY_CALLS' });
  });
  it('the daily reset rolls over a year end', () => {
    const r = checkCaps(
      AI_CAP_DEFAULTS,
      usage({ callsToday: 20 }),
      '0',
      new Date('2026-12-31T23:59:00.000Z'),
    );
    expect(r).toMatchObject({ resetsAt: '2027-01-01T00:00:00.000Z' });
  });
  it('allows one below each call cap and refuses at it', () => {
    expect(checkCaps(AI_CAP_DEFAULTS, usage({ callsThisMonth: 199 }), '0', NOW).allowed).toBe(true);
    expect(checkCaps(AI_CAP_DEFAULTS, usage({ callsThisMonth: 200 }), '0', NOW).allowed).toBe(
      false,
    );
  });
  it('a projected cost of exactly the remaining budget is allowed', () => {
    expect(checkCaps(AI_CAP_DEFAULTS, usage({ costThisMonthUsd: '4' }), '1', NOW).allowed).toBe(
      true,
    );
  });
  it('fails closed on Infinity, fractional counts and a negative or empty projection', () => {
    for (const [u, p] of [
      [usage({ callsToday: Infinity }), '0'],
      [usage({ callsToday: 1.5 }), '0'],
      [usage(), ''],
    ] as const) {
      expect(checkCaps(AI_CAP_DEFAULTS, u, p, NOW).allowed).toBe(false);
    }
  });
  it('month boundaries are exact', () => {
    expect(nextUtcMonthStart(new Date('2026-01-31T23:59:59.999Z')).toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(utcMonthStart(new Date('2024-02-29T12:00:00.000Z')).toISOString()).toBe(
      '2024-02-01T00:00:00.000Z',
    );
    expect(nextUtcMonthStart(new Date('2024-02-29T12:00:00.000Z')).toISOString()).toBe(
      '2024-03-01T00:00:00.000Z',
    );
  });
});

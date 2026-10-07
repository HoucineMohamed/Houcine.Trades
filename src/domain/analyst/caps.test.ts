import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import {
  AI_CAP_CEILINGS,
  AI_CAP_DEFAULTS,
  AI_LOOSEN_DELAY_MS,
  checkCaps,
  parseCaps,
  parseCapsJson,
  parsePendingCapsJson,
  requestCapsChange,
  settleCaps,
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

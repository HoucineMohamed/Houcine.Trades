import { describe, expect, it } from 'vitest';
import { calculatePositionSize, type SizeInput } from './size';

const base: SizeInput = {
  equity: '10000',
  riskPercent: '1',
  direction: 'long',
  entry: '100',
  stop: '95',
};
const ok = (over: Partial<SizeInput>) => {
  const r = calculatePositionSize({ ...base, ...over });
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.problems)}`);
  return r;
};
const refused = (over: Partial<SizeInput>) => {
  const r = calculatePositionSize({ ...base, ...over });
  if (r.ok) throw new Error('expected a refusal');
  return r.problems.map((p) => p.code);
};

describe('golden: exact sizes (hand-computed)', () => {
  it('long: equity 10000, risk 1 %, entry 100, stop 95, target 115', () => {
    // budget = 10000 x 1 / 100 = 100 ; distance = |100 - 95| = 5 ; size = 100 / 5 = 20
    // risk amount = 20 x 5 = 100 (1.0000 % of equity) ; notional = 20 x 100 = 2000
    // reward = |115 - 100| = 15 -> reward-to-risk = 15 / 5 = 3
    const r = ok({ target: '115' });
    expect(r).toMatchObject({
      size: '20',
      riskBudget: '100',
      riskAmount: '100',
      estimatedFees: '0',
      riskPercentUsed: '1.0000',
      notional: '2000',
      rewardToRisk: '3.0000',
    });
  });

  it('short: equity 5000, risk 1 %, entry 200, stop 210, step 0.1, target 180', () => {
    // budget = 50 ; distance = 10 ; raw size = 5 -> /0.1 = 50 -> floor 50 -> size 5
    // risk = 5 x 10 = 50 ; notional = 5 x 200 = 1000 ; reward = 20 -> 20 / 10 = 2
    const r = ok({
      equity: '5000',
      direction: 'short',
      entry: '200',
      stop: '210',
      sizeStep: '0.1',
      target: '180',
    });
    expect(r).toMatchObject({
      size: '5',
      riskAmount: '50',
      notional: '1000',
      rewardToRisk: '2.0000',
    });
  });

  it('no target: reward-to-risk is null', () => {
    expect(ok({}).rewardToRisk).toBeNull();
  });
});

describe('size is always rounded DOWN, never up', () => {
  // equity 1000, 1 % = budget 10, entry 100, stop 97 -> distance 3 -> exact size 3.3333...
  const third = { equity: '1000', entry: '100', stop: '97' };

  it('without a step: truncated at 18 decimals, so the risk stays under the budget', () => {
    const r = ok(third);
    expect(r.size).toBe('3.333333333333333333'); // ...34 would round UP and exceed the budget
    // 3.333333333333333333 x 3 = 9.999999999999999999 (just under 10)
    expect(r.riskAmount).toBe('9.999999999999999999');
    // 9.999999999999999999 x 100 / 1000 = 0.9999999999999999999 % -> shown rounded UP: 1.0000
    expect(r.riskPercentUsed).toBe('1.0000');
  });

  it('with step 0.01: floor(333.33) = 333 -> size 3.33, risk 9.99', () => {
    const r = ok({ ...third, sizeStep: '0.01' });
    expect(r).toMatchObject({ size: '3.33', riskAmount: '9.99', riskPercentUsed: '0.9990' });
  });

  it('with step 0.1: floor(33.33) = 33 -> size 3.3, risk 9.9', () => {
    expect(ok({ ...third, sizeStep: '0.1' })).toMatchObject({ size: '3.3', riskAmount: '9.9' });
  });

  it('a size that is already an exact multiple of the step is kept', () => {
    // budget 100 / distance 5 = 20 ; step 0.5 -> 40 steps exactly
    expect(ok({ sizeStep: '0.5' }).size).toBe('20');
  });

  it('a step bigger than the exact size gives a refusal, not a rounded-up size', () => {
    // exact size 20 < step 25 -> floor(0.8) = 0
    expect(refused({ sizeStep: '25' })).toEqual(['SIZE_BELOW_MINIMUM']);
  });
});

describe('minimum size and tiny crypto amounts', () => {
  it('minimum size: the rounded-down size must reach it', () => {
    // step 0.01 -> 3.33 (see above) ; minimum 5 -> refused ; minimum 3.33 -> allowed (exactly equal)
    expect(
      refused({ equity: '1000', entry: '100', stop: '97', sizeStep: '0.01', minSize: '5' }),
    ).toEqual(['SIZE_BELOW_MINIMUM']);
    expect(
      ok({ equity: '1000', entry: '100', stop: '97', sizeStep: '0.01', minSize: '3.33' }).size,
    ).toBe('3.33');
    expect(
      refused({ equity: '1000', entry: '100', stop: '97', sizeStep: '0.01', minSize: '3.34' }),
    ).toEqual(['SIZE_BELOW_MINIMUM']);
  });

  it('BTC: equity 1000, risk 1 % = 10, entry 100000, stop 97000, step 0.00001', () => {
    // distance 3000 ; raw = 10 / 3000 = 0.003333... ; / 0.00001 = 333.33 -> 333 -> size 0.00333
    // risk = 0.00333 x 3000 = 9.99 ; notional = 0.00333 x 100000 = 333
    const r = ok({ equity: '1000', entry: '100000', stop: '97000', sizeStep: '0.00001' });
    expect(r).toMatchObject({ size: '0.00333', riskAmount: '9.99', notional: '333' });
  });

  it('a tiny account: equity 10, risk 1 % = 0.1, distance 1000 -> size exactly 0.0001', () => {
    const r = ok({ equity: '10', entry: '100000', stop: '99000', sizeStep: '0.00001' });
    expect(r).toMatchObject({ size: '0.0001', riskAmount: '0.1', riskPercentUsed: '1.0000' });
  });

  it('a budget too small for even one step is refused', () => {
    // equity 1 -> budget 0.01 ; distance 1000 -> raw 0.00001 ; step 0.0001 -> 0
    expect(refused({ equity: '1', entry: '100000', stop: '99000', sizeStep: '0.0001' })).toEqual([
      'SIZE_BELOW_MINIMUM',
    ]);
  });
});

describe('estimated fees (round trip, percent of the trade value)', () => {
  it('equity 10000, 1 %, entry 100, stop 95, fees 0.2 %, step 0.01', () => {
    // fee per unit = 100 x 0.2 / 100 = 0.2 ; risk per unit = 5 + 0.2 = 5.2 ; budget 100
    // raw = 100 / 5.2 = 19.2307... -> step 0.01 -> 19.23
    // price risk = 19.23 x 5 = 96.15 ; fees = 19.23 x 0.2 = 3.846 ; total = 99.996 (<= 100)
    // percent used = 99.996 x 100 / 10000 = 0.99996 -> rounded UP to 4 places = 1.0000
    const r = ok({ feeRoundTripPercent: '0.2', sizeStep: '0.01' });
    expect(r).toMatchObject({
      size: '19.23',
      riskAmount: '96.15',
      estimatedFees: '3.846',
      riskPercentUsed: '1.0000',
    });
  });

  it('fees make the size smaller than without fees', () => {
    expect(Number(ok({ feeRoundTripPercent: '0.5' }).size)).toBeLessThan(Number(ok({}).size));
  });
});

describe('refusals (fail closed)', () => {
  it('zero stop distance', () => {
    expect(refused({ stop: '100' })).toEqual(['ZERO_STOP_DISTANCE']);
  });
  it('wrong-side stops', () => {
    expect(refused({ stop: '101' })).toEqual(['STOP_WRONG_SIDE']); // long, stop above entry
    expect(refused({ direction: 'short', stop: '99' })).toEqual(['STOP_WRONG_SIDE']); // short, stop below entry
  });
  it('missing or invalid stop', () => {
    expect(refused({ stop: null })).toEqual(['NO_STOP_LOSS']);
    expect(refused({ stop: '' })).toEqual(['NO_STOP_LOSS']);
    expect(refused({ stop: 'abc' })).toEqual(['NO_STOP_LOSS']);
    expect(refused({ stop: '0' })).toEqual(['NO_STOP_LOSS']);
  });
  it('missing, zero or invalid equity', () => {
    for (const equity of [null, '0', '-5', 'abc', ''])
      expect(refused({ equity })).toContain('EQUITY_UNAVAILABLE');
  });
  it('risk percent: above the hard ceiling of 2 % is refused, exactly 2 is allowed', () => {
    expect(refused({ riskPercent: '2.0000001' })).toEqual(['RISK_ABOVE_CEILING']);
    expect(ok({ riskPercent: '2' }).size).toBe('40'); // budget 200 / 5
    expect(refused({ riskPercent: '0' })).toEqual(['INVALID_RISK_PERCENT']);
    expect(refused({ riskPercent: null })).toEqual(['INVALID_RISK_PERCENT']);
  });
  it('bad entry, direction, step, minimum, fees', () => {
    expect(refused({ entry: null })).toContain('INVALID_PLAN');
    expect(refused({ entry: '0' })).toContain('INVALID_PLAN');
    expect(refused({ direction: 'up' })).toContain('INVALID_PLAN');
    expect(refused({ sizeStep: '0' })).toEqual(['INVALID_STEP']);
    expect(refused({ minSize: '0' })).toEqual(['INVALID_MIN_SIZE']);
    expect(refused({ feeRoundTripPercent: '100' })).toEqual(['INVALID_FEE']);
    expect(refused({ feeRoundTripPercent: '-1' })).toEqual(['INVALID_FEE']);
  });
  it('a target on the wrong side', () => {
    expect(refused({ target: '90' })).toEqual(['TARGET_WRONG_SIDE']); // long, target below entry
    expect(refused({ direction: 'short', stop: '105', target: '110' })).toEqual([
      'TARGET_WRONG_SIDE',
    ]);
  });
  it('reports every problem at once', () => {
    expect(refused({ equity: null, stop: null, riskPercent: '9' }).sort()).toEqual([
      'EQUITY_UNAVAILABLE',
      'NO_STOP_LOSS',
      'RISK_ABOVE_CEILING',
    ]);
  });
});

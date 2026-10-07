import { describe, expect, it } from 'vitest';
import {
  costFromPrice,
  DEFAULT_ANALYST_MODEL,
  estimateCostUsd,
  isPricedModel,
  PRICES_LAST_VERIFIED,
  PRICE_TABLE,
} from './pricing';

describe('price table', () => {
  it('has a "last verified" date that is a real date', () => {
    expect(PRICES_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(PRICES_LAST_VERIFIED).getTime())).toBe(false);
  });

  it('prices the default model', () => {
    expect(isPricedModel(DEFAULT_ANALYST_MODEL)).toBe(true);
  });

  it('has positive decimal prices for every model', () => {
    for (const [model, p] of Object.entries(PRICE_TABLE)) {
      expect(p.inputPerMTok, model).toMatch(/^\d+(\.\d+)?$/);
      expect(p.outputPerMTok, model).toMatch(/^\d+(\.\d+)?$/);
      expect(Number(p.inputPerMTok)).toBeGreaterThan(0);
      expect(Number(p.outputPerMTok)).toBeGreaterThan(0);
    }
  });
});

describe('estimateCostUsd', () => {
  it('is exact: 1M input + 1M output of Sonnet 5.5 is 2 + 10 dollars', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000)).toBe('12.000000');
  });
  it('works for a typical call', () => {
    // 8000 in x $2/M = 0.016 ; 1500 out x $10/M = 0.015
    expect(estimateCostUsd('claude-sonnet-5-5', 8000, 1500)).toBe('0.031000');
  });
  it('rounds UP so the estimate never understates', () => {
    expect(estimateCostUsd('claude-haiku-4-5', 1, 0)).toBe('0.000001');
    expect(estimateCostUsd('claude-haiku-4-5', 0, 0)).toBe('0.000000');
  });
  it('is null for an unknown model or invalid token counts (the caller must refuse)', () => {
    expect(estimateCostUsd('some-new-model', 10, 10)).toBeNull();
    expect(estimateCostUsd('claude-sonnet-5-5', -1, 0)).toBeNull();
    expect(estimateCostUsd('claude-sonnet-5-5', 1.5, 0)).toBeNull();
    expect(estimateCostUsd('constructor', 1, 1)).toBeNull();
    expect(estimateCostUsd('__proto__', 1, 1)).toBeNull();
  });
});

describe('rounding is UP (exercised with prices that need rounding)', () => {
  const p = (inputPerMTok: string, outputPerMTok: string) => ({
    inputPerMTok,
    outputPerMTok,
    supportsEffort: false,
  });
  it('1 token at 0.3 USD per million is 0.0000003, shown as 0.000001', () => {
    expect(costFromPrice(p('0.3', '0'), 1, 0)).toBe('0.000001');
  });
  it('1 output token at 2.5 is 0.0000025, shown as 0.000003', () => {
    expect(costFromPrice(p('0', '2.5'), 0, 1)).toBe('0.000003');
  });
  it('just over a boundary rounds up, exactly on it does not', () => {
    expect(costFromPrice(p('1.1', '0'), 1_000_001, 0)).toBe('1.100002');
    expect(costFromPrice(p('1', '0'), 1_000_000, 0)).toBe('1.000000');
  });
});

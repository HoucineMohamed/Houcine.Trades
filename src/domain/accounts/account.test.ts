import { describe, expect, it } from 'vitest';
import { parseWith, ValidationError } from '../errors';
import { setupSchema } from '../setups/setup';
import { assertAccountModeAllowed, createAccountSchema } from './account';

describe('account input', () => {
  it('defaults to paper mode and normalises values', () => {
    expect(
      parseWith(createAccountSchema, {
        name: ' Main ',
        baseCurrency: 'usd',
        startingBalance: '10000.00',
      }),
    ).toEqual({ name: 'Main', mode: 'paper', baseCurrency: 'USD', startingBalance: '10000' });
  });

  it('rejects bad input with clear messages', () => {
    expect(() =>
      parseWith(createAccountSchema, { name: '', baseCurrency: 'USD', startingBalance: '1' }),
    ).toThrow(/Account name/);
    expect(() =>
      parseWith(createAccountSchema, { name: 'A', baseCurrency: 'USD', startingBalance: '-1' }),
    ).toThrow(/Starting balance/);
    expect(() =>
      parseWith(createAccountSchema, { name: 'A', baseCurrency: 'USD', startingBalance: '1e3' }),
    ).toThrow(/Starting balance/);
    expect(() =>
      parseWith(createAccountSchema, { name: 'A', baseCurrency: '$', startingBalance: '1' }),
    ).toThrow(/Base currency/);
    expect(() =>
      parseWith(createAccountSchema, {
        name: 'A',
        mode: 'demo',
        baseCurrency: 'USD',
        startingBalance: '1',
      }),
    ).toThrow(/Mode/);
  });
});

describe('paper-mode guard for accounts', () => {
  it('allows paper accounts', () => {
    expect(() => assertAccountModeAllowed('paper', 'paper')).not.toThrow();
  });

  it('refuses live accounts while the app is in paper mode', () => {
    expect(() => assertAccountModeAllowed('live', 'paper')).toThrow(ValidationError);
    expect(() => assertAccountModeAllowed('live', 'paper')).toThrow(/paper mode only/);
  });
});

describe('setup input', () => {
  it('requires a name, trims, defaults description', () => {
    expect(parseWith(setupSchema, { name: ' Breakout ' })).toEqual({
      name: 'Breakout',
      description: '',
    });
    expect(() => parseWith(setupSchema, { name: '  ' })).toThrow(/Setup name/);
    expect(() => parseWith(setupSchema, {})).toThrow(/Setup name/);
  });
});

import { describe, expect, it } from 'vitest';
import { displayMoney } from './display';

describe('displayMoney', () => {
  it.each([
    ['6.24752500', '6.247525'],
    ['-9.25000000', '-9.25'],
    ['10', '10'],
    ['0', '0'],
    ['0.00000001', '0.00000001'],
    ['0.000000001', '0'], // below 8 places: rounds to zero, never "-0" or an exponent
    ['-0.000000001', '0'],
    ['1.123456785', '1.12345678'], // half-even: ...78|5 stays 78
    ['1.123456775', '1.12345678'], // half-even: ...77|5 rounds up to 78
    ['0.000000000000000000000000000000000004', '0'],
    ['123456789012345678901234567890.5', '123456789012345678901234567890.5'],
  ])('%s -> %s', (value, expected) => {
    expect(displayMoney(value)).toBe(expected);
  });

  it('can use another number of places', () => {
    expect(displayMoney('1.23456', 2)).toBe('1.23');
  });
});

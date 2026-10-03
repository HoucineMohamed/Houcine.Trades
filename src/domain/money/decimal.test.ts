import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  compareDecimal,
  DecimalError,
  formatDecimal,
  isDecimalString,
  isPositive,
  isZero,
  normalizeDecimal,
  parseDecimal,
} from './decimal';

describe('isDecimalString / parseDecimal', () => {
  it.each(['0', '1', '100', '0.1', '0.00000001', '123456.789', '0.000000000000000001'])(
    'accepts %s',
    (v) => {
      expect(isDecimalString(v)).toBe(true);
      expect(() => parseDecimal(v)).not.toThrow();
    },
  );

  it.each([
    '',
    ' ',
    ' 1',
    '1 ',
    '-1',
    '+1',
    '1e5',
    '1E-7',
    'NaN',
    'Infinity',
    '1,5',
    '.5',
    '5.',
    '1.2.3',
    '0x10',
    'abc',
    '1'.repeat(31),
    '0.' + '1'.repeat(19),
  ])('rejects %j with a clear message', (v) => {
    expect(isDecimalString(v)).toBe(false);
    expect(() => parseDecimal(v)).toThrow(DecimalError);
    expect(() => parseDecimal(v)).toThrow(/not a valid amount/);
  });

  it('rejects non-strings', () => {
    expect(isDecimalString(1)).toBe(false);
    expect(isDecimalString(null)).toBe(false);
    expect(isDecimalString(undefined)).toBe(false);
  });
});

describe('precision (no floats)', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    // Proof that plain JS floats get this wrong:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('keeps very small crypto amounts exact', () => {
    expect(addDecimal('0.00000001', '0.00000002')).toBe('0.00000003');
    expect(addDecimal('0.000000000000000001', '0.000000000000000001')).toBe('0.000000000000000002');
  });

  it('keeps large values exact', () => {
    expect(addDecimal('123456789012345678901234567890', '1')).toBe(
      '123456789012345678901234567891',
    );
  });

  it('never returns exponent notation', () => {
    expect(normalizeDecimal('0.000000000000000001')).toBe('0.000000000000000001');
    expect(addDecimal('0.0000001', '0')).toBe('0.0000001');
  });
});

describe('normalize / compare / sign helpers', () => {
  it('normalizes trailing and leading zeros', () => {
    expect(normalizeDecimal('0.10')).toBe('0.1');
    expect(normalizeDecimal('007')).toBe('7');
    expect(normalizeDecimal('1.000')).toBe('1');
    expect(normalizeDecimal('0.0')).toBe('0');
  });

  it('compares numerically, not as text', () => {
    expect(compareDecimal('9', '10')).toBe(-1);
    expect(compareDecimal('10', '9')).toBe(1);
    expect(compareDecimal('1.0', '1')).toBe(0);
    expect(compareDecimal('0.00000001', '0.0000001')).toBe(-1);
  });

  it('isPositive / isZero', () => {
    expect(isPositive('0.00000001')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('0.000')).toBe(false);
    expect(isZero('0.0')).toBe(true);
    expect(isZero('0.1')).toBe(false);
  });
});

describe('formatDecimal', () => {
  it('shows the exact value by default', () => {
    expect(formatDecimal('0.00012300')).toBe('0.000123');
  });

  it('rounds half-even and pads when decimals are given', () => {
    expect(formatDecimal('1.5', 2)).toBe('1.50');
    expect(formatDecimal('0.125', 2)).toBe('0.12');
    expect(formatDecimal('0.135', 2)).toBe('0.14');
    expect(formatDecimal('2', 0)).toBe('2');
  });
});

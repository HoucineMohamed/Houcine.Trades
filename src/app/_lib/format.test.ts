import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatCountdown,
  formatMoney,
  formatMoneySigned,
  formatPercent,
  formatR,
  formatSigned,
  formatUtc,
  groupThousands,
  resultKind,
  safeHttpUrl,
} from './format';

describe('groupThousands', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['1234567', '1,234,567'],
    ['-1234567.8901', '-1,234,567.8901'],
    ['1000000.123456', '1,000,000.123456'],
    ['12345.678', '12,345.678'],
  ])('%s -> %s', (input, expected) => {
    expect(groupThousands(input)).toBe(expected);
  });
  it('never touches text that is not a plain number', () => {
    for (const s of ['', 'abc', '1e6', '1,000', '--1', '1.', '.5', ' 5']) {
      expect(groupThousands(s)).toBe(s);
    }
  });
});

describe('formatAmount', () => {
  it('trims trailing zeros, groups, and never shows -0', () => {
    expect(formatAmount('10000.00000000')).toBe('10,000');
    expect(formatAmount('1234.5000')).toBe('1,234.5');
    expect(formatAmount('-0.000000001')).toBe('0');
  });
  it('rounds half-even to the requested places', () => {
    expect(formatAmount('0.125', 2)).toBe('0.12');
    expect(formatAmount('0.135', 2)).toBe('0.14');
  });
  it('returns invalid text unchanged', () => {
    expect(formatAmount('n/a')).toBe('n/a');
  });
});

describe('resultKind and formatSigned', () => {
  it('classifies by sign, exactly', () => {
    expect(resultKind('0.00000001')).toBe('profit');
    expect(resultKind('-0.00000001')).toBe('loss');
    expect(resultKind('0')).toBe('flat');
    expect(resultKind('-0')).toBe('flat');
    expect(resultKind('0.000')).toBe('flat');
    expect(resultKind('nope')).toBe('flat');
  });
  it('adds an explicit sign, separators and a neutral word', () => {
    expect(formatSigned('1234.5')).toEqual({ text: '+1,234.5', kind: 'profit', word: 'profit' });
    expect(formatSigned('-1234.5')).toEqual({
      text: '\u22121,234.5',
      kind: 'loss',
      word: 'loss',
    });
    expect(formatSigned('0')).toEqual({ text: '0', kind: 'flat', word: 'break-even' });
  });
  it('a value that rounds to zero for display is break-even, with no sign', () => {
    expect(formatSigned('-0.000000001')).toMatchObject({ text: '0', kind: 'flat' });
    expect(formatSigned('0.004', 2)).toMatchObject({ text: '0', kind: 'flat' });
  });
  it('invalid text is shown as is, as break-even, never throws', () => {
    expect(formatSigned('oops')).toEqual({ text: 'oops', kind: 'flat', word: 'break-even' });
  });
  it('uses no advice words', () => {
    const words = [formatSigned('1'), formatSigned('-1'), formatSigned('0')].map((s) => s.word);
    expect(words.join(' ')).not.toMatch(/good|bad|win|lose|great|poor/i);
  });
});

describe('formatR', () => {
  it('keeps the engine decimals and adds a sign', () => {
    expect(formatR('1.5000')).toMatchObject({ text: '+1.5000 R', kind: 'profit' });
    expect(formatR('-0.2500')).toMatchObject({ text: '\u22120.2500 R', kind: 'loss' });
    expect(formatR('0.0000')).toMatchObject({ text: '0.0000 R', kind: 'flat' });
  });
});

describe('small formatters', () => {
  it('formatPercent', () => {
    expect(formatPercent('12.50')).toBe('12.50 %');
    expect(formatPercent('x')).toBe('x');
  });
  it('formatUtc is time-zone independent and tolerant', () => {
    expect(formatUtc('2026-03-10T12:34:56.000Z')).toBe('2026-03-10 12:34 UTC');
    expect(formatUtc(null)).toBe('');
    expect(formatUtc('garbage')).toBe('');
  });
  it('formatCountdown', () => {
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(1000)).toBe('1s');
    expect(formatCountdown(61_000)).toBe('1m 01s');
    expect(formatCountdown(3_600_000 + 5 * 60_000)).toBe('1h 05m');
    expect(formatCountdown(-5)).toBe('0s');
  });
});

describe('safeHttpUrl: links only for http and https', () => {
  it('accepts http and https', () => {
    expect(safeHttpUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    expect(safeHttpUrl('  https://example.com  ')).toBe('https://example.com/');
  });
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com',
    '//example.com',
    'example.com',
    '',
    'C:\\screenshots\\a.png',
  ])('refuses %s', (value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });
  it('refuses null and undefined', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe('formatMoney and formatMoneySigned', () => {
  it('two decimals from 1 upward, grouped, padded', () => {
    expect(formatMoney('11403.301211')).toBe('11,403.30');
    expect(formatMoney('10000')).toBe('10,000.00');
    expect(formatMoney('1403.3')).toBe('1,403.30');
    expect(formatMoney('-1234.5678')).toBe('-1,234.57');
    expect(formatMoney('1')).toBe('1.00');
  });
  it('below 1 keeps up to eight decimals so a tiny amount never looks like zero', () => {
    expect(formatMoney('0.5')).toBe('0.5');
    expect(formatMoney('0.00000123')).toBe('0.00000123');
    expect(formatMoney('0')).toBe('0');
    expect(formatMoney('0.999999999')).toBe('1');
  });
  it('rounds half-even like the rest of the app', () => {
    expect(formatMoney('2.125')).toBe('2.12');
    expect(formatMoney('2.135')).toBe('2.14');
  });
  it('signed: sign, word and money precision', () => {
    expect(formatMoneySigned('1403.301211')).toEqual({
      text: '+1,403.30',
      kind: 'profit',
      word: 'profit',
    });
    expect(formatMoneySigned('-38.462661')).toEqual({ text: '−38.46', kind: 'loss', word: 'loss' });
    expect(formatMoneySigned('0')).toMatchObject({ text: '0', kind: 'flat' });
    expect(formatMoneySigned('0.000000004')).toMatchObject({ text: '0', kind: 'flat' });
    expect(formatMoneySigned('-0.00000002')).toMatchObject({ text: '−0.00000002', kind: 'loss' });
    expect(formatMoneySigned('oops')).toMatchObject({ text: 'oops', kind: 'flat' });
  });
});

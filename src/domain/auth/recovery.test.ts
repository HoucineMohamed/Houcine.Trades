import { describe, expect, it } from 'vitest';
import {
  formatRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  RECOVERY_CODE_COUNT,
} from './recovery';

describe('recovery code format', () => {
  it('there are 10 codes of 16 characters', () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it('normalises case, spaces and dashes', () => {
    expect(normalizeRecoveryCode('abcd-efgh-ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode(' abcd efgh  ijkl mnop ')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJKLMNOP');
  });

  it('rejects wrong length and characters outside the alphabet (0, 1, 8, 9 are not in Base32)', () => {
    for (const bad of [
      '',
      'ABCD-EFGH',
      'ABCDEFGHIJKLMNO',
      'ABCDEFGHIJKLMNOPQ',
      'ABCDEFGHIJKLMN01',
      'ABCDEFGHIJKLMN89',
      'ABCD!FGHIJKLMNOP',
    ]) {
      expect(normalizeRecoveryCode(bad), bad).toBeNull();
    }
  });

  it('formats in groups of four', () => {
    expect(formatRecoveryCode('ABCDEFGHIJKLMNOP')).toBe('ABCD-EFGH-IJKL-MNOP');
  });

  it('authenticator codes are exactly 6 digits, spaces ignored', () => {
    expect(normalizeTotpCode('123456')).toBe('123456');
    expect(normalizeTotpCode('123 456')).toBe('123456');
    for (const bad of ['12345', '1234567', 'abcdef', '12345a', '', '123-456'])
      expect(normalizeTotpCode(bad), bad).toBeNull();
  });
});

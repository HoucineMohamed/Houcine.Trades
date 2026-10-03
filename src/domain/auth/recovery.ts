/**
 * Recovery codes: 10 one-time codes, 16 characters of Base32 (80 bits of randomness), shown as
 * XXXX-XXXX-XXXX-XXXX. Generation needs randomness, so it lives in src/auth; this file is the
 * pure format handling.
 */

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 16;
export const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** "abcd efgh-ijkl_mnop" -> "ABCDEFGHIJKLMNOP" (null when it cannot be a recovery code). */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function formatRecoveryCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)?.join('-') ?? normalized;
}

/** A 6-digit authenticator code, spaces ignored ("123 456" is fine). */
export function normalizeTotpCode(input: string): string | null {
  const cleaned = input.replace(/\s/g, '');
  return /^\d{6}$/.test(cleaned) ? cleaned : null;
}

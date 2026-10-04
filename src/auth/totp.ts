import 'server-only';
import { Secret, TOTP } from 'otpauth';
import { renderUnicodeCompact } from 'uqr';
import { normalizeTotpCode } from '@/domain/auth/recovery';

/**
 * Authenticator-app codes (TOTP, RFC 6238) through the vetted `otpauth` library.
 * 6 digits, 30-second steps, SHA-1 (what authenticator apps use), one step of clock drift allowed
 * in each direction, and REPLAY PROTECTION: a time step that was already used (or any older one)
 * can never be accepted again.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DRIFT_STEPS = 1;
export const TOTP_ISSUER = 'Houcine.Trades';
export const TOTP_LABEL = 'owner';

/** A new random 160-bit secret, as Base32 text (what you type into an authenticator app). */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The otpauth:// link that authenticator apps read (also encoded in the QR code). */
export function totpUri(secretBase32: string): string {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: TOTP_LABEL,
    secret: Secret.fromBase32(secretBase32),
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).toString();
}

/** A QR code for the terminal (the setup scripts show it once). */
export function totpQr(uri: string): string {
  return renderUnicodeCompact(uri);
}

/** The time step (number of 30 s periods since 1970) that contains `now`. */
export const stepAt = (now: Date): number =>
  TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: now.getTime() });

export type TotpResult = { ok: true; step: number } | { ok: false };

/**
 * Checks a code. `lastUsedStep` is the newest step ever accepted (null if none): the code must be
 * for a STRICTLY NEWER step, so the same code (or any older one) is refused even if it is still
 * inside the drift window. On success, store the returned `step` as the new lastUsedStep.
 */
export function verifyTotp(args: {
  secretBase32: string;
  code: string;
  now: Date;
  lastUsedStep: number | null;
}): TotpResult {
  const token = normalizeTotpCode(args.code);
  if (token === null) return { ok: false };
  let delta: number | null;
  try {
    delta = TOTP.validate({
      token,
      secret: Secret.fromBase32(args.secretBase32),
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      timestamp: args.now.getTime(),
      window: TOTP_DRIFT_STEPS,
    });
  } catch {
    return { ok: false };
  }
  if (delta === null) return { ok: false };
  const step = stepAt(args.now) + delta;
  if (args.lastUsedStep !== null && step <= args.lastUsedStep) return { ok: false }; // replay
  return { ok: true, step };
}

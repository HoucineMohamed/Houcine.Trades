import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  normalizeRecoveryCode,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
} from '@/domain/auth/recovery';

/**
 * Cryptographic building blocks. Everything here uses well-known primitives (argon2id, AES-256-GCM,
 * HKDF-SHA256, SHA-256, crypto.randomBytes) and never logs or returns secrets in error messages.
 */

// ---- password hashing (argon2id) ----------------------------------------------------------------

/**
 * argon2id with 64 MiB of memory, 3 passes, 1 lane (about 0.4 s on a normal computer). OWASP's
 * minimum is 19 MiB / 2 passes, so this is well above it. The parameters are stored inside each
 * hash, so they can be raised later without breaking old hashes.
 */
export const ARGON2_OPTIONS = {
  // 2 = argon2id (the library's Algorithm enum is a `const enum`, which this project cannot import
  // by name). A test asserts that every hash really is argon2id.
  algorithm: 2,
  memoryCost: 65_536, // KiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** NFKC makes the same typed password identical on Windows and macOS keyboards. */
const prepare = (password: string) => password.normalize('NFKC');

// Tests hash dozens of passwords; they may switch to the OWASP minimum. This refuses to do
// anything outside the test runner, so it cannot weaken the real application.
let hashOptions:
  | typeof ARGON2_OPTIONS
  | { algorithm: 2; memoryCost: number; timeCost: number; parallelism: number } = ARGON2_OPTIONS;
export function enableFastPasswordHashingForTests(): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Fast password hashing is only allowed in tests.');
  hashOptions = { algorithm: 2, memoryCost: 8_192, timeCost: 1, parallelism: 1 };
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(prepare(password), hashOptions);
}

/** Never throws: a malformed hash or any error is simply "not a match". */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, prepare(password));
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Does the same work as a real password check against a hash nobody knows the password of. Used
 * when there is no owner (or no hash), so "no such owner" and "wrong password" take equally long.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, password);
  return false;
}

// ---- tokens, hashes, comparisons ------------------------------------------------------------------

/** 256 bits of randomness, URL-safe. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** SHA-256 hex. Used for session tokens and recovery codes, which are high-entropy random values. */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const hashSessionToken = (token: string): string => sha256Hex(token);

/** Constant-time equality of two strings (both are hashed first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ---- recovery codes -----------------------------------------------------------------------------------

/** Unbiased random Base32 characters (256 is divisible by 32, so no modulo bias). */
function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += RECOVERY_ALPHABET[b % 32];
  return out;
}

/** 10 distinct codes, normalised (no dashes). Show them once, store only their hashes. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(randomBase32(RECOVERY_CODE_LENGTH));
  return [...codes];
}

/** Hash of a recovery code as typed by the user (null if it cannot be a recovery code). */
export function hashRecoveryCodeInput(input: string): string | null {
  const normalized = normalizeRecoveryCode(input);
  return normalized === null ? null : sha256Hex(normalized);
}

// ---- encrypting the authenticator (TOTP) secret ---------------------------------------------------------

export class SecretUnavailableError extends Error {
  constructor() {
    super(
      'The stored authenticator secret cannot be read (AUTH_SECRET changed or the data is damaged).',
    );
    this.name = 'SecretUnavailableError';
  }
}

const HKDF_SALT = Buffer.from('houcine-trades/auth/v1', 'utf8');

/** A 256-bit key for one purpose, derived from AUTH_SECRET (different purposes get different keys). */
function deriveKey(authSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, HKDF_SALT, purpose, 32));
}

const TOTP_PURPOSE = 'totp-secret-v1';

/** AES-256-GCM. Output: v1.<iv>.<ciphertext>.<tag> (all base64url). A fresh random IV every time. */
export function encryptTotpSecret(plain: string, authSecret: string): string {
  const key = deriveKey(authSecret, TOTP_PURPOSE);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(TOTP_PURPOSE));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join(
    '.',
  );
}

/** Throws SecretUnavailableError (never the plaintext, never the key) when it cannot be decrypted. */
export function decryptTotpSecret(blob: string, authSecret: string): string {
  try {
    const [version, iv, ct, tag] = blob.split('.');
    if (version !== 'v1' || !iv || !ct || !tag) throw new Error('format');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(authSecret, TOTP_PURPOSE),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(TOTP_PURPOSE));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretUnavailableError();
  }
}

import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Backup encryption, done on the server BEFORE anything leaves it.
 *
 * Scheme: AES-256-GCM (authenticated: any change to the file, or a wrong key, is detected). The
 * AES key is derived per backup with HKDF-SHA256 from BACKUP_KEY and a fresh random salt, so one
 * BACKUP_KEY safely protects many backups and no nonce is ever reused with the same key.
 * Nothing but Node's built-in crypto is used. BACKUP_KEY is never AUTH_SECRET and is never stored
 * with a backup.
 *
 * File layout:  "HTB1" | salt (16) | iv (12) | ciphertext | tag (16)
 * The header (magic, salt, iv) AND the backup's own name (time, kind, migration count) are
 * authenticated as additional data, so an object swapped for another valid backup, or renamed to look
 * newer or older, fails to decrypt: what the name says is what the file is.
 */

const MAGIC = Buffer.from('HTB1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const INFO = Buffer.from('houcine-trades backup v1', 'utf8');

export type CryptoErrorCode = 'bad_format' | 'auth_failed';

/** A short code only. "auth_failed" means the key is wrong OR the file was changed or cut short. */
export class BackupCryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) {
    super(
      code === 'bad_format'
        ? 'not a Houcine.Trades backup file'
        : 'the backup could not be decrypted (wrong key, or the file was changed or cut short)',
    );
    this.name = 'BackupCryptoError';
  }
}

const PLACEHOLDER = /replace|change.?me|placeholder|example|your[-_ ]|insert|todo|xxxx/i;

/**
 * BACKUP_KEY: exactly 32 random bytes written as base64url (43 characters, no padding). Returns
 * null for anything else, including a placeholder or a key with no variety. Never throws, never
 * echoes the value.
 */
export function parseBackupKey(text: string | undefined): Buffer | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(t) || PLACEHOLDER.test(t)) return null;
  const bytes = Buffer.from(t, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== t) return null;
  if (new Set(bytes).size < 12) return null;
  return bytes;
}

/** A fresh BACKUP_KEY for `npm run backup:generate-key`. */
export function generateBackupKey(): string {
  // a random key that happens to look like a placeholder (about 1 in 10,000) is simply drawn again
  for (;;) {
    const key = randomBytes(32).toString('base64url');
    if (parseBackupKey(key) !== null) return key;
  }
}

/** The part of an object key that is authenticated: its name without the folder. */
export const backupContext = (objectKey: string): string =>
  objectKey.slice(objectKey.lastIndexOf('/') + 1);

function deriveKey(key: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, INFO, 32));
}

export function encryptBackup(plain: Buffer, key: Buffer, context: string): Buffer {
  if (key.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(context, 'utf8')]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export function decryptBackup(blob: Buffer, key: Buffer, context: string): Buffer {
  if (blob.length < HEADER_LEN + TAG_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupCryptoError('bad_format');
  }
  const header = blob.subarray(0, HEADER_LEN);
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = blob.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const body = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), iv);
    decipher.setAAD(Buffer.concat([header, Buffer.from(context, 'utf8')]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupCryptoError('auth_failed');
  }
}

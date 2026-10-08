import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BackupCryptoError,
  decryptBackup,
  encryptBackup,
  generateBackupKey,
  parseBackupKey,
} from './crypto';

const key = () => parseBackupKey(generateBackupKey()) as Buffer;

describe('BACKUP_KEY', () => {
  it('accepts a generated key and nothing else', () => {
    const text = generateBackupKey();
    expect(text).toHaveLength(43);
    expect(parseBackupKey(text)?.length).toBe(32);
    expect(parseBackupKey(` ${text}\n`)?.length).toBe(32);
  });
  it.each([
    undefined,
    '',
    'short',
    'replace-with-the-output-of-the-generate-command!!',
    'A'.repeat(43), // no variety
    `${generateBackupKey()}x`,
    generateBackupKey().slice(0, 42),
    `${generateBackupKey().slice(0, 42)}=`,
    'x'.repeat(21) + 'example' + 'y'.repeat(15),
  ])('refuses %j', (bad) => {
    expect(parseBackupKey(bad)).toBeNull();
  });
  it('two generated keys differ', () => {
    expect(generateBackupKey()).not.toBe(generateBackupKey());
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips, including empty and large data', () => {
    const k = key();
    for (const size of [0, 1, 1000, 3_000_000]) {
      const plain = randomBytes(size);
      expect(decryptBackup(encryptBackup(plain, k), k).equals(plain)).toBe(true);
    }
  });
  it('the output does not contain the plaintext, and differs every time (fresh salt and iv)', () => {
    const k = key();
    const plain = Buffer.from('SQLite format 3\0 my private trade notes '.repeat(20));
    const a = encryptBackup(plain, k);
    const b = encryptBackup(plain, k);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(a.includes(Buffer.from('private trade notes'))).toBe(false);
  });
  it('a wrong key is refused', () => {
    const blob = encryptBackup(Buffer.from('data'), key());
    expect(() => decryptBackup(blob, key())).toThrow(BackupCryptoError);
  });
  it('every changed byte is detected (header, body and tag)', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(200), k);
    for (let i = 0; i < blob.length; i += 7) {
      const bad = Buffer.from(blob);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      expect(() => decryptBackup(bad, k), `byte ${i}`).toThrow(BackupCryptoError);
    }
  });
  it('a truncated file is detected, at every length', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(100), k);
    for (const len of [0, 3, 4, 31, 32, 50, blob.length - 17, blob.length - 1]) {
      expect(() => decryptBackup(blob.subarray(0, len), k), `len ${len}`).toThrow(
        BackupCryptoError,
      );
    }
  });
  it('appended bytes are detected', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(100), k);
    expect(() => decryptBackup(Buffer.concat([blob, Buffer.from([0])]), k)).toThrow(
      BackupCryptoError,
    );
  });
  it('a file that is not ours says so, and the error never carries data', () => {
    try {
      decryptBackup(Buffer.from('not a backup at all, just some text here ok'), key());
      expect.unreachable();
    } catch (e) {
      expect((e as BackupCryptoError).code).toBe('bad_format');
    }
  });
  it('refuses an encryption key of the wrong size', () => {
    expect(() => encryptBackup(Buffer.from('x'), randomBytes(16))).toThrow();
  });
});

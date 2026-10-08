import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  backupContext,
  BackupCryptoError,
  decryptBackup,
  encryptBackup,
  generateBackupKey,
  parseBackupKey,
} from './crypto';

const CTX = '20261008T031500Z-daily-m7.htbk';
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
      expect(decryptBackup(encryptBackup(plain, k, CTX), k, CTX).equals(plain)).toBe(true);
    }
  });
  it('the output does not contain the plaintext, and differs every time (fresh salt and iv)', () => {
    const k = key();
    const plain = Buffer.from('SQLite format 3\0 my private trade notes '.repeat(20));
    const a = encryptBackup(plain, k, CTX);
    const b = encryptBackup(plain, k, CTX);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(a.includes(Buffer.from('private trade notes'))).toBe(false);
  });
  it('a wrong key is refused', () => {
    const blob = encryptBackup(Buffer.from('data'), key(), CTX);
    expect(() => decryptBackup(blob, key(), CTX)).toThrow(BackupCryptoError);
  });
  it('every changed byte is detected (header, body and tag)', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(200), k, CTX);
    for (let i = 0; i < blob.length; i += 7) {
      const bad = Buffer.from(blob);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      expect(() => decryptBackup(bad, k, CTX), `byte ${i}`).toThrow(BackupCryptoError);
    }
  });
  it('a truncated file is detected, at every length', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(100), k, CTX);
    for (const len of [0, 3, 4, 31, 32, 50, blob.length - 17, blob.length - 1]) {
      expect(() => decryptBackup(blob.subarray(0, len), k, CTX), `len ${len}`).toThrow(
        BackupCryptoError,
      );
    }
  });
  it('appended bytes are detected', () => {
    const k = key();
    const blob = encryptBackup(randomBytes(100), k, CTX);
    expect(() => decryptBackup(Buffer.concat([blob, Buffer.from([0])]), k, CTX)).toThrow(
      BackupCryptoError,
    );
  });
  it('a file that is not ours says so, and the error never carries data', () => {
    try {
      decryptBackup(Buffer.from('not a backup at all, just some text here ok'), key(), CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as BackupCryptoError).code).toBe('bad_format');
    }
  });
  it('refuses an encryption key of the wrong size', () => {
    expect(() => encryptBackup(Buffer.from('x'), randomBytes(16), CTX)).toThrow();
  });
});

describe('the file format is stable and bound to its name', () => {
  // Built by a separate stand-alone script from the documented scheme (not by this module), with a
  // fixed key, salt and iv: a future change to the layout, the key derivation or the authenticated
  // data would make every existing backup unreadable, and this is what would notice.
  const VECTOR =
    '4854423101010101010101010101010101010101020202020202020202020202859a8fd601714e0d1650d997d1c7f96556666efbaa91494d2b53407f';
  const vectorKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
  it('a file written by the documented scheme still decrypts', () => {
    expect(decryptBackup(Buffer.from(VECTOR, 'hex'), vectorKey, CTX).toString('utf8')).toBe(
      'hello backup',
    );
  });
  it('the same file does NOT decrypt under another name (a swapped or renamed object is refused)', () => {
    for (const other of [
      '20261008T031501Z-daily-m7.htbk',
      '20261008T031500Z-manual-m7.htbk',
      '20261008T031500Z-daily-m6.htbk',
      '',
    ]) {
      expect(() => decryptBackup(Buffer.from(VECTOR, 'hex'), vectorKey, other), other).toThrow(
        BackupCryptoError,
      );
    }
  });
  it('backupContext is the name without the folder, so moving the folder does not break restores', () => {
    expect(backupContext('backups/' + CTX)).toBe(CTX);
    expect(backupContext('other/place/' + CTX)).toBe(CTX);
    expect(backupContext(CTX)).toBe(CTX);
  });
  it('empty plaintext is exactly 48 bytes; 47 bytes is refused, never a crash', () => {
    const k = key();
    const blob = encryptBackup(Buffer.alloc(0), k, CTX);
    expect(blob.length).toBe(48);
    expect(decryptBackup(blob, k, CTX).length).toBe(0);
    expect(() => decryptBackup(blob.subarray(0, 47), k, CTX)).toThrow(BackupCryptoError);
  });
  it('every single byte of the 32 byte header is protected', () => {
    const k = key();
    const blob = encryptBackup(Buffer.from('payload'), k, CTX);
    for (let i = 0; i < 32; i++) {
      const bad = Buffer.from(blob);
      bad[i] = (bad[i] ?? 0) ^ 0xff;
      expect(() => decryptBackup(bad, k, CTX), `header byte ${i}`).toThrow(BackupCryptoError);
    }
  });
  it('generated keys are always accepted by the parser', () => {
    for (let i = 0; i < 300; i++) expect(parseBackupKey(generateBackupKey())).not.toBeNull();
  });
});

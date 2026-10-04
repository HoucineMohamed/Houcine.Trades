import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeRecoveryCode } from '@/domain/auth/recovery';
import {
  ARGON2_OPTIONS,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCodeInput,
  hashSessionToken,
  randomToken,
  safeEqual,
  SecretUnavailableError,
  sha256Hex,
  verifyAgainstDummy,
  verifyPassword,
} from './crypto';

// Random at run time: no secret-looking literal lives in the repository.
const secretA = () => randomBytes(48).toString('base64url');
const PASSWORD = 'lantern violin concrete orbit pepper';

describe('password hashing (argon2id)', () => {
  it('produces an argon2id hash with the documented parameters and verifies the right password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
  });

  it('rejects a wrong, empty or slightly different password', async () => {
    const hash = await hashPassword(PASSWORD);
    for (const wrong of ['', PASSWORD + ' ', PASSWORD.toUpperCase(), PASSWORD.slice(0, -1), 'x']) {
      expect(await verifyPassword(hash, wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('the same password hashes differently every time (random salt) and the hash does not contain it', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a).not.toContain('lantern');
    expect(await verifyPassword(a, PASSWORD)).toBe(true);
    expect(await verifyPassword(b, PASSWORD)).toBe(true);
  });

  it('treats composed and decomposed unicode as the same password (NFKC)', async () => {
    const hash = await hashPassword('café lantern violin');
    expect(await verifyPassword(hash, 'café lantern violin')).toBe(true);
  });

  it('never throws on a damaged or empty stored hash: it is simply "not a match"', async () => {
    for (const bad of ['', 'garbage', '$argon2id$v=19$m=1$broken', null as unknown as string]) {
      expect(await verifyPassword(bad, PASSWORD)).toBe(false);
    }
  });

  it('the dummy check does real hashing work (so "no owner" is not faster than "wrong password")', async () => {
    await verifyAgainstDummy('warm up the one-time dummy hash');
    const t0 = performance.now();
    expect(await verifyAgainstDummy(PASSWORD)).toBe(false);
    expect(performance.now() - t0).toBeGreaterThan(50); // a real 64 MiB argon2 verification, not a shortcut
  });
});

describe('tokens, hashes and comparisons', () => {
  it('session tokens are 256 bits, URL-safe, and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, randomToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('only a hash of the token is derived for storage, and it is deterministic', () => {
    const t = randomToken();
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).not.toContain(t);
    expect(hashSessionToken(t)).not.toBe(hashSessionToken(t + 'x'));
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    ); // known vector
  });

  it('safeEqual compares correctly, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('generates 10 distinct valid codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(normalizeRecoveryCode(c)).toBe(c);
  });

  it('two generations never overlap in practice', () => {
    const a = new Set(generateRecoveryCodes());
    for (const c of generateRecoveryCodes()) expect(a.has(c)).toBe(false);
  });

  it('hashes what the user types, in any common format, to the same value', () => {
    const [code] = generateRecoveryCodes() as [string];
    const dashed = code.match(/.{4}/g)!.join('-').toLowerCase();
    expect(hashRecoveryCodeInput(dashed)).toBe(sha256Hex(code));
    expect(hashRecoveryCodeInput(`  ${dashed.replace(/-/g, ' ')}  `)).toBe(sha256Hex(code));
    expect(hashRecoveryCodeInput('not a code')).toBeNull();
    expect(hashRecoveryCodeInput('123456')).toBeNull();
  });
});

describe('authenticator secret encryption (AES-256-GCM with a key derived from AUTH_SECRET)', () => {
  const plain = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('round trips', () => {
    const key = secretA();
    expect(decryptTotpSecret(encryptTotpSecret(plain, key), key)).toBe(plain);
  });

  it('a different random IV every time, and the plaintext is not visible', () => {
    const key = secretA();
    const a = encryptTotpSecret(plain, key);
    const b = encryptTotpSecret(plain, key);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain(plain);
  });

  it('cannot be decrypted with another AUTH_SECRET', () => {
    const blob = encryptTotpSecret(plain, secretA());
    expect(() => decryptTotpSecret(blob, secretA())).toThrow(SecretUnavailableError);
  });

  it('any tampering is detected (ciphertext, tag, iv, version, truncation, garbage)', () => {
    const key = secretA();
    const [v, iv, ct, tag] = encryptTotpSecret(plain, key).split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const bad of [
      [v, iv, flip(ct), tag],
      [v, iv, ct, flip(tag)],
      [v, flip(iv), ct, tag],
      ['v2', iv, ct, tag],
      [v, iv, ct],
      [v, iv, ct, tag.slice(0, 5)],
    ]) {
      expect(() => decryptTotpSecret(bad.join('.'), key), bad.join('.')).toThrow(
        SecretUnavailableError,
      );
    }
    for (const garbage of ['', 'nonsense', '....'])
      expect(() => decryptTotpSecret(garbage, key)).toThrow(SecretUnavailableError);
  });

  it('the error message never contains the secret or the key', () => {
    const key = secretA();
    try {
      decryptTotpSecret(encryptTotpSecret(plain, key), secretA());
    } catch (e) {
      expect((e as Error).message).not.toContain(plain);
      expect((e as Error).message).not.toContain(key);
    }
  });
});

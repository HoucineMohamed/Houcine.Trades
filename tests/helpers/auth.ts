import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { parseAuthEnv, type AuthEnv } from '@/auth/env';
import { enableFastPasswordHashingForTests } from '@/auth/crypto';
import { createOwner } from '@/auth/service';
import type { ClientInfo } from '@/auth/client';
import type { Db } from '@/data/client';
import { issueFreshAuth, type FreshAuth } from '@/domain/auth/stepup';
import { memoryDb } from './db';

enableFastPasswordHashingForTests();

export const PASSWORD = 'lantern violin concrete orbit pepper';
export const NEW_PASSWORD = 'harbor quartz meadow velvet anchor';

/** A fresh random AUTH_SECRET each run: no secret-looking literal lives in the repository. */
export const testEnv = (extra: Record<string, string> = {}): AuthEnv =>
  parseAuthEnv({ AUTH_SECRET: randomBytes(48).toString('base64url'), ...extra });

export const CLIENT: ClientInfo = { ip: 'direct', userAgent: 'test-browser' };
export const clientFrom = (ip: string): ClientInfo => ({ ip, userAgent: 'test-browser' });

export const T0 = new Date('2026-03-10T12:00:00.000Z');
export const after = (ms: number, from: Date = T0) => new Date(from.getTime() + ms);

/** The authenticator code for `secret` at `at` (what the owner's phone would show). */
export function codeAt(secret: string, at: Date): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    timestamp: at.getTime(),
  });
}

export interface TestOwner {
  db: Db;
  env: AuthEnv;
  secret: string;
  recoveryCodes: string[];
}

/** A database with the owner created (through the real service) at T0. */
export async function dbWithOwner(env: AuthEnv = testEnv()): Promise<TestOwner> {
  const db = memoryDb();
  const e = await createOwner(db, PASSWORD, { env, now: T0 });
  return { db, env, secret: e.totpSecret, recoveryCodes: e.recoveryCodes };
}

/** A genuine FreshAuth proof, for tests of the data-layer functions that require one. */
export const freshAuthForTests = (sessionId = 1, at: Date = new Date()): FreshAuth =>
  issueFreshAuth(sessionId, at);

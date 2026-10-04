import { describe, expect, it } from 'vitest';
import { createOwnerFlow, resetOwnerFlow, type Io } from '../../scripts/auth/flows';
import { getOwner } from '@/data/auth';
import { listAuthEvents } from '@/data/auth';
import { memoryDb } from '../helpers/db';
import { dbWithOwner, NEW_PASSWORD, PASSWORD, testEnv } from '../helpers/auth';

/** A fake terminal: answers are read from queues, and everything printed is captured. */
function fakeIo(secrets: string[], lines: string[] = ['']) {
  const out: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    readSecret: async (prompt) => {
      asked.push(prompt);
      const v = secrets.shift();
      if (v === undefined) throw new Error('unexpected password prompt');
      return v;
    },
    readLine: async (prompt) => {
      asked.push(prompt);
      return lines.shift() ?? '';
    },
    print: (line = '') => void out.push(line),
  };
  return { io, out, text: () => out.join('\n'), asked };
}

describe('npm run auth:create-owner', () => {
  it('creates the owner, prints the secret, the link, a QR code and 10 recovery codes ONCE, and never the password', async () => {
    const db = memoryDb();
    const t = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerFlow(t.io, db, { env: testEnv() })).toBe(0);
    expect(getOwner(db)).toBeDefined();
    const text = t.text();
    expect(text).toMatch(/otpauth:\/\/totp\/Houcine\.Trades:owner\?\S*secret=[A-Z2-7]{32}/);
    expect(text).toMatch(/\n {3}[A-Z2-7]{32}\n/); // the secret for manual entry
    expect(text.match(/ {3}[A-Z2-7]{4}(-[A-Z2-7]{4}){3}/g)).toHaveLength(10);
    expect(text).toContain('shown ONCE');
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain('\u001b[2J'); // the screen is cleared after you confirm
    expect(listAuthEvents(db).map((e) => e.kind)).toEqual(['owner_created']);
  });

  it('refuses a weak password, explains why, and lets you try again', async () => {
    const db = memoryDb();
    const t = fakeIo(['password1234', PASSWORD, PASSWORD]);
    expect(await createOwnerFlow(t.io, db, { env: testEnv() })).toBe(0);
    expect(t.text()).toMatch(/too easy to guess/);
    expect(getOwner(db)).toBeDefined();
  });

  it('refuses a mismatched confirmation, then accepts a matching one', async () => {
    const db = memoryDb();
    const t = fakeIo([PASSWORD, NEW_PASSWORD, PASSWORD, PASSWORD]);
    expect(await createOwnerFlow(t.io, db, { env: testEnv() })).toBe(0);
    expect(t.text()).toMatch(/not the same/);
  });

  it('gives up after 3 bad attempts and creates nothing', async () => {
    const db = memoryDb();
    const t = fakeIo(['short', 'password1234', '123456789012']);
    expect(await createOwnerFlow(t.io, db, { env: testEnv() })).toBe(1);
    expect(getOwner(db)).toBeUndefined();
    expect(t.text()).toMatch(/Too many attempts/);
  });

  it('refuses when an owner already exists (and never asks for a password)', async () => {
    const o = await dbWithOwner();
    const t = fakeIo([]);
    expect(await createOwnerFlow(t.io, o.db, { env: o.env })).toBe(1);
    expect(t.text()).toMatch(/owner already exists.*auth:reset/);
    expect(t.asked).toEqual([]);
  });

  it('reports a missing or invalid AUTH_SECRET clearly, without printing it', async () => {
    const db = memoryDb();
    const t = fakeIo([PASSWORD, PASSWORD]);
    expect(await createOwnerFlow(t.io, db, { env: undefined })).toBe(1); // no AUTH_SECRET in the test environment
    expect(t.text()).toMatch(/Invalid authentication settings/);
    expect(getOwner(db)).toBeUndefined();
  });
});

describe('npm run auth:reset', () => {
  it('needs an existing owner', async () => {
    const t = fakeIo([]);
    expect(await resetOwnerFlow(t.io, memoryDb(), { env: testEnv() })).toBe(1);
    expect(t.text()).toMatch(/no owner yet/);
  });

  it('does nothing unless you type RESET', async () => {
    const o = await dbWithOwner();
    const before = getOwner(o.db)!.passwordHash;
    for (const answer of ['', 'reset', 'yes']) {
      const t = fakeIo([NEW_PASSWORD, NEW_PASSWORD], [answer]);
      expect(await resetOwnerFlow(t.io, o.db, { env: o.env })).toBe(1);
      expect(t.asked.some((a) => a.includes('password'))).toBe(false);
    }
    expect(getOwner(o.db)!.passwordHash).toBe(before);
  });

  it('with RESET: new password, authenticator and recovery codes are shown once; the password never', async () => {
    const o = await dbWithOwner();
    const t = fakeIo([NEW_PASSWORD, NEW_PASSWORD], ['RESET', '']);
    expect(await resetOwnerFlow(t.io, o.db, { env: o.env })).toBe(0);
    expect(getOwner(o.db)!.passwordHash).not.toBe('');
    expect(t.text()).toMatch(/otpauth:\/\/totp/);
    expect(t.text()).not.toContain(NEW_PASSWORD);
    expect(listAuthEvents(o.db).map((e) => e.kind)).toContain('owner_reset');
  });
});

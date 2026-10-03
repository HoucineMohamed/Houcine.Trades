import { describe, expect, it } from 'vitest';
import {
  appendAuthEvent,
  claimTotpStep,
  clearBucket,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  failureTimes,
  findSessionByTokenHash,
  getOwner,
  insertOwner,
  insertSession,
  listAuthEvents,
  listSessions,
  markStepUp,
  pruneAttempts,
  recordFailedAttempt,
  replaceRecoveryCodes,
  revokeAllSessions,
  revokeSession,
  touchSession,
  updateOwnerPassword,
  updateOwnerTotp,
} from '@/data/auth';
import { memoryDb } from '../helpers/db';

const T = new Date('2026-03-10T12:00:00.000Z');
const later = (ms: number) => new Date(T.getTime() + ms);
const hashes = (n: number, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function dbWithOwner() {
  const db = memoryDb();
  insertOwner(db, { passwordHash: 'pw-hash', totpSecretEnc: 'enc-secret', now: T });
  return db;
}

describe('exactly one owner, enforced by the database', () => {
  it('stores the owner once; a second owner is refused', () => {
    const db = dbWithOwner();
    expect(getOwner(db)).toMatchObject({
      id: 1,
      passwordHash: 'pw-hash',
      totpSecretEnc: 'enc-secret',
      totpLastStep: null,
      createdAt: T.toISOString(),
    });
    expect(() =>
      insertOwner(db, { passwordHash: 'other', totpSecretEnc: 'other', now: T }),
    ).toThrow(/UNIQUE|constraint/i);
    expect(getOwner(db)?.passwordHash).toBe('pw-hash');
  });

  it('a row with any other id is refused by a CHECK constraint (not only by code)', () => {
    const db = memoryDb();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO owner (id, password_hash, totp_secret_enc, created_at, updated_at, password_changed_at) VALUES (2,'a','b','t','t','t')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect((db.$client.prepare('SELECT count(*) c FROM owner').get() as { c: number }).c).toBe(0);
  });

  it('the owner cannot be deleted and its id cannot be changed', () => {
    const db = dbWithOwner();
    expect(() => db.$client.prepare('DELETE FROM owner').run()).toThrow(/cannot be deleted/);
    expect(() => db.$client.prepare('UPDATE owner SET id = 2').run()).toThrow(/cannot be changed/);
    expect(getOwner(db)).toBeDefined();
  });

  it('changing the password updates the hash and its timestamps', () => {
    const db = dbWithOwner();
    updateOwnerPassword(db, 'new-hash', later(5000));
    expect(getOwner(db)).toMatchObject({
      passwordHash: 'new-hash',
      passwordChangedAt: later(5000).toISOString(),
      createdAt: T.toISOString(),
    });
  });

  it('re-enrolling the authenticator replaces the secret and restarts the replay counter', () => {
    const db = dbWithOwner();
    claimTotpStep(db, 500);
    updateOwnerTotp(db, 'enc-2', later(1000));
    expect(getOwner(db)).toMatchObject({ totpSecretEnc: 'enc-2', totpLastStep: null });
  });
});

describe('authenticator replay protection is atomic', () => {
  it('a step can be claimed once; the same or an older step never again', () => {
    const db = dbWithOwner();
    expect(claimTotpStep(db, 1000)).toBe(true);
    expect(claimTotpStep(db, 1000)).toBe(false);
    expect(claimTotpStep(db, 999)).toBe(false);
    expect(claimTotpStep(db, 0)).toBe(false);
    expect(claimTotpStep(db, 1001)).toBe(true);
    expect(getOwner(db)?.totpLastStep).toBe(1001);
  });

  it('two simultaneous attempts with the same code: exactly one wins', () => {
    const db = dbWithOwner();
    const results = [claimTotpStep(db, 42), claimTotpStep(db, 42)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('recovery codes work once', () => {
  it('stores 10 codes; each can be consumed exactly once', () => {
    const db = dbWithOwner();
    replaceRecoveryCodes(db, hashes(10), T);
    expect(countUnusedRecoveryCodes(db)).toBe(10);
    expect(consumeRecoveryCode(db, 'h3', later(1))).toBe(true);
    expect(consumeRecoveryCode(db, 'h3', later(2))).toBe(false);
    expect(countUnusedRecoveryCodes(db)).toBe(9);
    expect(consumeRecoveryCode(db, 'unknown', later(3))).toBe(false);
  });

  it('replacing the set revokes the unused old codes (they stop working) and keeps the used ones as history', () => {
    const db = dbWithOwner();
    replaceRecoveryCodes(db, hashes(10, 'old'), T);
    consumeRecoveryCode(db, 'old0', later(1));
    replaceRecoveryCodes(db, hashes(10, 'new'), later(10));
    expect(consumeRecoveryCode(db, 'old1', later(11))).toBe(false); // revoked
    expect(consumeRecoveryCode(db, 'new1', later(11))).toBe(true);
    expect(countUnusedRecoveryCodes(db)).toBe(9);
    const old0 = db.$client
      .prepare("SELECT used_at, revoked_at FROM recovery_codes WHERE code_hash = 'old0'")
      .get() as { used_at: string; revoked_at: string | null };
    expect(old0.used_at).toBe(later(1).toISOString());
    expect(old0.revoked_at).toBeNull(); // a used code is history, not "revoked"
  });

  it('the database refuses to make a used code valid again, to change a hash, or to delete rows', () => {
    const db = dbWithOwner();
    replaceRecoveryCodes(db, hashes(3), T);
    consumeRecoveryCode(db, 'h0', later(1));
    expect(() =>
      db.$client.prepare("UPDATE recovery_codes SET used_at = NULL WHERE code_hash = 'h0'").run(),
    ).toThrow(/cannot be made valid again/);
    expect(() =>
      db.$client.prepare("UPDATE recovery_codes SET used_at = 'x' WHERE code_hash = 'h0'").run(),
    ).toThrow(/cannot be made valid again/);
    expect(() =>
      db.$client
        .prepare("UPDATE recovery_codes SET code_hash = 'zzz' WHERE code_hash = 'h1'")
        .run(),
    ).toThrow(/cannot be changed/);
    expect(() => db.$client.prepare('DELETE FROM recovery_codes').run()).toThrow(
      /kept for the audit trail/,
    );
    expect(consumeRecoveryCode(db, 'h0', later(5))).toBe(false);
  });

  it('two codes can never share a hash', () => {
    const db = dbWithOwner();
    expect(() => replaceRecoveryCodes(db, ['dup', 'dup'], T)).toThrow(/UNIQUE|constraint/i);
  });
});

describe('sessions', () => {
  const make = (db: ReturnType<typeof memoryDb>, hash = 'tok-hash', now = T) =>
    insertSession(db, {
      tokenHash: hash,
      now,
      ip: '127.0.0.1',
      userAgent: 'test-browser',
      stepUpAt: null,
    });

  it('is stored by token HASH and found by it', () => {
    const db = dbWithOwner();
    const s = make(db);
    expect(s).toMatchObject({
      tokenHash: 'tok-hash',
      createdAt: T.toISOString(),
      lastSeenAt: T.toISOString(),
      stepUpAt: null,
      revokedAt: null,
    });
    expect(findSessionByTokenHash(db, 'tok-hash')?.id).toBe(s.id);
    expect(findSessionByTokenHash(db, 'other')).toBeUndefined();
    expect(() => make(db)).toThrow(/UNIQUE|constraint/i); // a token hash is unique
  });

  it('records activity and step-up', () => {
    const db = dbWithOwner();
    const s = make(db);
    touchSession(db, s.id, later(60_000));
    markStepUp(db, s.id, later(70_000));
    expect(findSessionByTokenHash(db, 'tok-hash')).toMatchObject({
      lastSeenAt: later(60_000).toISOString(),
      stepUpAt: later(70_000).toISOString(),
    });
  });

  it('revoking works once and is final (the database refuses to restore it)', () => {
    const db = dbWithOwner();
    const s = make(db);
    expect(revokeSession(db, s.id, 'logout', later(1))).toBe(true);
    expect(revokeSession(db, s.id, 'again', later(2))).toBe(false);
    expect(findSessionByTokenHash(db, 'tok-hash')).toMatchObject({
      revokedAt: later(1).toISOString(),
      revokedReason: 'logout',
    });
    expect(() =>
      db.$client.prepare('UPDATE sessions SET revoked_at = NULL WHERE id = ?').run(s.id),
    ).toThrow(/cannot be restored/);
    expect(() =>
      db.$client.prepare("UPDATE sessions SET revoked_at = 'x' WHERE id = ?").run(s.id),
    ).toThrow(/cannot be restored/);
  });

  it('revoke-all can keep one session', () => {
    const db = dbWithOwner();
    const a = make(db, 'a');
    const b = make(db, 'b');
    const c = make(db, 'c');
    expect(revokeAllSessions(db, 'password_changed', later(1), b.id)).toBe(2);
    const states = Object.fromEntries(
      listSessions(db).map((s) => [s.tokenHash, s.revokedAt !== null]),
    );
    expect(states).toEqual({ a: true, b: false, c: true });
    expect(revokeAllSessions(db, 'logout_all', later(2))).toBe(1);
    void a;
    void c;
  });

  it('a token hash or creation time cannot be changed, and sessions cannot be deleted', () => {
    const db = dbWithOwner();
    const s = make(db);
    expect(() =>
      db.$client.prepare("UPDATE sessions SET token_hash = 'forged' WHERE id = ?").run(s.id),
    ).toThrow(/cannot be changed/);
    expect(() =>
      db.$client.prepare("UPDATE sessions SET created_at = 'x' WHERE id = ?").run(s.id),
    ).toThrow(/cannot be changed/);
    expect(() => db.$client.prepare('DELETE FROM sessions').run()).toThrow(/audit trail/);
  });

  it('lists newest first, including revoked ones', () => {
    const db = dbWithOwner();
    make(db, 'one');
    const two = make(db, 'two');
    revokeSession(db, two.id, 'x', later(1));
    expect(listSessions(db).map((s) => s.tokenHash)).toEqual(['two', 'one']);
  });
});

describe('authentication event log is append-only', () => {
  it('adds events, newest first, and truncates a long user-agent', () => {
    const db = dbWithOwner();
    appendAuthEvent(db, {
      kind: 'login_failure',
      now: T,
      ip: '127.0.0.1',
      userAgent: 'x'.repeat(500),
      detail: 'invalid_credentials',
    });
    appendAuthEvent(db, { kind: 'login_success', now: later(1000) });
    const events = listAuthEvents(db);
    expect(events.map((e) => e.kind)).toEqual(['login_success', 'login_failure']);
    expect(events[1]!.userAgent).toHaveLength(200);
    expect(events[1]).toMatchObject({ detail: 'invalid_credentials', ip: '127.0.0.1' });
  });

  it('rows can never be changed or deleted, and unknown kinds are refused', () => {
    const db = dbWithOwner();
    appendAuthEvent(db, { kind: 'logout', now: T });
    expect(() => db.$client.prepare("UPDATE auth_events SET detail = 'edited'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.$client.prepare('DELETE FROM auth_events').run()).toThrow(/append-only/);
    expect(() =>
      db.$client
        .prepare("INSERT INTO auth_events (kind, created_at) VALUES ('made_up', 't')")
        .run(),
    ).toThrow(/CHECK/);
    expect(listAuthEvents(db)).toHaveLength(1);
  });
});

describe('failed attempts (for the progressive delays)', () => {
  it('records processed failures per bucket and reads them back by time', () => {
    const db = dbWithOwner();
    const ms = T.getTime();
    recordFailedAttempt(db, ['global', 'source:a'], 'login', ms);
    recordFailedAttempt(db, ['global', 'source:b'], 'login', ms + 1000);
    recordFailedAttempt(db, ['global'], 'step_up', ms + 2000);
    expect(failureTimes(db, 'global', ms - 1)).toEqual([ms, ms + 1000, ms + 2000]);
    expect(failureTimes(db, 'source:a', ms - 1)).toEqual([ms]);
    expect(failureTimes(db, 'global', ms + 1000)).toEqual([ms + 2000]); // strictly newer than "since"
    expect(failureTimes(db, 'source:none', 0)).toEqual([]);
  });

  it('a successful login clears that source only; pruning removes old rows', () => {
    const db = dbWithOwner();
    const ms = T.getTime();
    recordFailedAttempt(db, ['global', 'source:a'], 'login', ms);
    recordFailedAttempt(db, ['global', 'source:b'], 'login', ms);
    clearBucket(db, 'source:a');
    expect(failureTimes(db, 'source:a', 0)).toEqual([]);
    expect(failureTimes(db, 'source:b', 0)).toHaveLength(1);
    expect(failureTimes(db, 'global', 0)).toHaveLength(2);
    pruneAttempts(db, ms + 1);
    expect(failureTimes(db, 'global', 0)).toEqual([]);
  });
});

import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { AttemptKind, AuthEventKind } from '@/domain/auth/events';
import type { Db, Reader, Writer } from './client';
import { authAttempts, authEvents, owner, recoveryCodes, sessions } from './schema';
import type { AuthEventRow, OwnerRow, SessionRow } from './schema';

/**
 * Data access for authentication: plain reads and writes only. All decisions (is this password
 * right, is this code fresh, may this attempt proceed) live in src/auth and src/domain/auth.
 * Where a rule must be race-proof (a code used once, a replayed TOTP step) it is done as a single
 * atomic UPDATE with a condition, never as read-then-write.
 */

// ---- owner -------------------------------------------------------------------------------------

export function getOwner(db: Reader): OwnerRow | undefined {
  return db.select().from(owner).where(eq(owner.id, 1)).get();
}

export function insertOwner(
  tx: Writer,
  v: { passwordHash: string; totpSecretEnc: string; now: Date },
): void {
  const at = v.now.toISOString();
  // The primary key plus CHECK (id = 1) makes a second owner impossible: this throws if one exists.
  tx.insert(owner)
    .values({
      id: 1,
      passwordHash: v.passwordHash,
      totpSecretEnc: v.totpSecretEnc,
      totpLastStep: null,
      createdAt: at,
      updatedAt: at,
      passwordChangedAt: at,
    })
    .run();
}

export function updateOwnerPassword(tx: Writer, passwordHash: string, now: Date): void {
  const at = now.toISOString();
  tx.update(owner)
    .set({ passwordHash, passwordChangedAt: at, updatedAt: at })
    .where(eq(owner.id, 1))
    .run();
}

/** New authenticator secret (re-enrolment). The replay counter starts again. */
export function updateOwnerTotp(tx: Writer, totpSecretEnc: string, now: Date): void {
  tx.update(owner)
    .set({ totpSecretEnc, totpLastStep: null, updatedAt: now.toISOString() })
    .where(eq(owner.id, 1))
    .run();
}

/**
 * Replay protection, atomically: record `step` as used ONLY if it is newer than every step used
 * before. Returns false when it is not (so two simultaneous requests with the same code cannot
 * both succeed).
 */
export function claimTotpStep(tx: Writer, step: number): boolean {
  const result = tx
    .update(owner)
    .set({ totpLastStep: step })
    .where(and(eq(owner.id, 1), or(isNull(owner.totpLastStep), lt(owner.totpLastStep, step))))
    .run();
  return result.changes === 1;
}

// ---- recovery codes ----------------------------------------------------------------------------

/** Replaces all current codes with a new set (the old ones are marked revoked, never deleted). */
export function replaceRecoveryCodes(tx: Writer, hashes: string[], now: Date): void {
  const at = now.toISOString();
  tx.update(recoveryCodes)
    .set({ revokedAt: at })
    .where(and(isNull(recoveryCodes.revokedAt), isNull(recoveryCodes.usedAt)))
    .run();
  for (const codeHash of hashes) {
    tx.insert(recoveryCodes).values({ codeHash, createdAt: at }).run();
  }
}

/** Uses a recovery code ONCE, atomically. True only if this call is the one that used it. */
export function consumeRecoveryCode(tx: Writer, codeHash: string, now: Date): boolean {
  const result = tx
    .update(recoveryCodes)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        eq(recoveryCodes.codeHash, codeHash),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.revokedAt),
      ),
    )
    .run();
  return result.changes === 1;
}

export function countUnusedRecoveryCodes(db: Reader): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(recoveryCodes)
      .where(and(isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)))
      .get()?.n ?? 0
  );
}

// ---- sessions -----------------------------------------------------------------------------------

export function insertSession(
  tx: Writer,
  v: { tokenHash: string; now: Date; ip: string; userAgent: string; stepUpAt: Date | null },
): SessionRow {
  const at = v.now.toISOString();
  return tx
    .insert(sessions)
    .values({
      tokenHash: v.tokenHash,
      createdAt: at,
      lastSeenAt: at,
      stepUpAt: v.stepUpAt ? v.stepUpAt.toISOString() : null,
      ip: v.ip,
      userAgent: v.userAgent,
    })
    .returning()
    .get();
}

export function findSessionByTokenHash(db: Reader, tokenHash: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
}

export function touchSession(tx: Writer, id: number, now: Date): void {
  tx.update(sessions).set({ lastSeenAt: now.toISOString() }).where(eq(sessions.id, id)).run();
}

export function markStepUp(tx: Writer, id: number, now: Date): void {
  tx.update(sessions).set({ stepUpAt: now.toISOString() }).where(eq(sessions.id, id)).run();
}

/** Revokes one session. True if it was active and is now revoked. */
export function revokeSession(tx: Writer, id: number, reason: string, now: Date): boolean {
  const r = tx
    .update(sessions)
    .set({ revokedAt: now.toISOString(), revokedReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .run();
  return r.changes === 1;
}

/** Revokes every active session, optionally keeping one. Returns how many were revoked. */
export function revokeAllSessions(
  tx: Writer,
  reason: string,
  now: Date,
  exceptId: number | null = null,
): number {
  const where =
    exceptId === null
      ? isNull(sessions.revokedAt)
      : and(isNull(sessions.revokedAt), ne(sessions.id, exceptId));
  return tx
    .update(sessions)
    .set({ revokedAt: now.toISOString(), revokedReason: reason })
    .where(where)
    .run().changes;
}

/** Newest first. Includes revoked ones (marked) so the history is visible. */
export function listSessions(db: Reader, limit = 50): SessionRow[] {
  return db.select().from(sessions).orderBy(desc(sessions.id)).limit(limit).all();
}

// ---- events -------------------------------------------------------------------------------------

export function appendAuthEvent(
  tx: Writer,
  e: {
    kind: AuthEventKind;
    now: Date;
    sessionId?: number | null;
    ip?: string;
    userAgent?: string;
    detail?: string;
  },
): void {
  tx.insert(authEvents)
    .values({
      kind: e.kind,
      createdAt: e.now.toISOString(),
      sessionId: e.sessionId ?? null,
      ip: e.ip ?? '',
      userAgent: (e.userAgent ?? '').slice(0, 200),
      detail: e.detail ?? '',
    })
    .run();
}

export function listAuthEvents(db: Reader, limit = 50): AuthEventRow[] {
  return db.select().from(authEvents).orderBy(desc(authEvents.id)).limit(limit).all();
}

// ---- throttle (failed attempts that were processed) -----------------------------------------------

export function recordFailedAttempt(
  tx: Writer,
  buckets: string[],
  kind: AttemptKind,
  atMs: number,
): void {
  for (const bucket of buckets) tx.insert(authAttempts).values({ bucket, kind, atMs }).run();
}

/** Epoch-ms times of processed failures in a bucket since `sinceMs`. */
export function failureTimes(db: Reader, bucket: string, sinceMs: number): number[] {
  return db
    .select({ atMs: authAttempts.atMs })
    .from(authAttempts)
    .where(and(eq(authAttempts.bucket, bucket), gt(authAttempts.atMs, sinceMs)))
    .orderBy(asc(authAttempts.atMs))
    .all()
    .map((r) => r.atMs);
}

/** A successful login clears that source's failures (the global bucket just ages out). */
export function clearBucket(tx: Writer, bucket: string): void {
  tx.delete(authAttempts).where(eq(authAttempts.bucket, bucket)).run();
}

export function pruneAttempts(tx: Writer, beforeMs: number): void {
  tx.delete(authAttempts).where(lt(authAttempts.atMs, beforeMs)).run();
}

export type { Db };

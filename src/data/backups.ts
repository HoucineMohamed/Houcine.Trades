import { and, desc, eq, max } from 'drizzle-orm';
import type { BackupErrorCode, BackupKind, BackupOutcome } from '../domain/hosting/kinds';
import type { Reader, Writer } from './client';
import { backupRuns, owner, type BackupRunRow } from './schema';

/** Backup bookkeeping (module 8). Append-only: the database refuses UPDATE and DELETE. */

export interface BackupRunInput {
  kind: BackupKind;
  outcome: BackupOutcome;
  startedAt: Date;
  finishedAt: Date;
  objectKey?: string;
  sizeBytes?: number;
  sha256?: string;
  errorCode?: BackupErrorCode;
}

export function appendBackupRun(db: Writer, run: BackupRunInput): number {
  const row = db
    .insert(backupRuns)
    .values({
      kind: run.kind,
      outcome: run.outcome,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt.toISOString(),
      objectKey: run.objectKey ?? null,
      sizeBytes: run.sizeBytes ?? null,
      sha256: run.sha256 ?? null,
      errorCode: run.errorCode ?? null,
    })
    .returning({ id: backupRuns.id })
    .get();
  return row.id;
}

export function listBackupRuns(db: Reader, limit = 30): BackupRunRow[] {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.id)).limit(limit).all();
}

export interface BackupStatusInput {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastAttemptAt: string | null;
  /** Backups are expected from the moment the owner exists. */
  trackingSince: string | null;
}

export function readBackupStatus(db: Reader): BackupStatusInput {
  const latest = (outcome?: BackupOutcome) =>
    db
      .select({ at: max(backupRuns.finishedAt) })
      .from(backupRuns)
      .where(outcome ? and(eq(backupRuns.outcome, outcome)) : undefined)
      .get()?.at ?? null;
  return {
    lastSuccessAt: latest('ok'),
    lastFailureAt: latest('failed'),
    lastAttemptAt: latest(),
    trackingSince: db.select({ at: owner.createdAt }).from(owner).get()?.at ?? null,
  };
}

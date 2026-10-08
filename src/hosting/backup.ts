import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendBackupRun } from '@/data/backups';
import type { Db } from '@/data/client';
import type { BackupErrorCode, BackupKind } from '@/domain/hosting/kinds';
import {
  backupObjectKey,
  parseBackupKey as parseKeyName,
  planRetention,
} from '@/domain/hosting/retention';
import { announce } from './announce';
import { BackupCryptoError, decryptBackup, encryptBackup } from './crypto';
import { inspectDatabaseFile } from './migrations';
import { StoreError, type ObjectStore } from './object-store';
import type { Logger } from './logger';

/**
 * One backup, start to finish:
 *  1. a consistent snapshot with SQLite's own online-backup mechanism (never a raw copy of the live file),
 *  2. an integrity check of the snapshot,
 *  3. compress, then encrypt ON THE SERVER with BACKUP_KEY,
 *  4. upload,
 *  5. download it again and check it: same bytes, decrypts, and is the same database.
 * Only after step 5 is the backup called successful. Every failure becomes a short code, is recorded
 * (append-only) and announced; nothing here throws to the caller.
 */

export interface BackupDeps {
  db: Db;
  store: ObjectStore;
  /** The 32-byte BACKUP_KEY. */
  key: Buffer;
  prefix: string;
  /** A private folder on the persistent disk for the short-lived plaintext snapshot. */
  tmpDir: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log?: Logger;
}

export type BackupResult =
  | {
      ok: true;
      objectKey: string;
      sizeBytes: number;
      sha256: string;
      runId: number | null;
      startedAt: Date;
      finishedAt: Date;
    }
  | { ok: false; code: BackupErrorCode; runId: number | null };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

class Step extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(code);
  }
}

function storeCode(e: unknown): BackupErrorCode {
  if (e instanceof StoreError) {
    if (e.code === 'denied') return 'store_denied';
    if (e.code === 'network' || e.code === 'timeout' || e.code === 'server')
      return 'store_unreachable';
  }
  return 'upload_failed';
}

export async function runBackup(deps: BackupDeps, kind: BackupKind): Promise<BackupResult> {
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock();
  fs.mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(deps.tmpDir, `snapshot-${randomUUID()}.db`);
  let outcome:
    | { ok: true; objectKey: string; sizeBytes: number; sha256: string }
    | { ok: false; code: BackupErrorCode };
  try {
    // 1 + 2: a consistent snapshot, checked
    try {
      await deps.db.$client.backup(snapshot);
      fs.chmodSync(snapshot, 0o600);
    } catch {
      throw new Step('snapshot_failed');
    }
    let migrations: number;
    try {
      const facts = await inspectDatabaseFile(snapshot, deps.migrationsFolder);
      if (!facts.integrityOk || !facts.foreignKeysOk) throw new Step('snapshot_corrupt');
      migrations = facts.migrations.applied;
    } catch (e) {
      throw e instanceof Step ? e : new Step('snapshot_failed');
    }
    // 3: compress, then encrypt
    let plainHash: string;
    let blob: Buffer;
    try {
      const raw = fs.readFileSync(snapshot);
      plainHash = sha256(raw);
      blob = encryptBackup(gzipSync(raw, { level: 6 }), deps.key);
    } catch {
      throw new Step('encrypt_failed');
    }
    const objectKey = backupObjectKey(deps.prefix, startedAt, kind, migrations);
    const blobHash = sha256(blob);
    // 4: upload
    try {
      await deps.store.put(objectKey, blob);
    } catch (e) {
      throw new Step(storeCode(e));
    }
    // 5: download again and check; a backup that cannot be read back does not count
    try {
      const back = await deps.store.get(objectKey);
      if (back.length !== blob.length || sha256(back) !== blobHash) throw new Step('verify_failed');
      const again = sha256(gunzipSync(decryptBackup(back, deps.key)));
      if (again !== plainHash) throw new Step('verify_failed');
    } catch (e) {
      if (e instanceof StoreError && e.code !== 'not_found') {
        throw new Step(storeCode(e) === 'upload_failed' ? 'verify_failed' : storeCode(e));
      }
      // best effort: do not leave an unverified object behind that could be mistaken for a good one
      await deps.store.delete(objectKey).catch(() => undefined);
      throw e instanceof Step ? e : new Step('verify_failed');
    }
    outcome = { ok: true, objectKey, sizeBytes: blob.length, sha256: blobHash };
  } catch (e) {
    outcome = {
      ok: false,
      code:
        e instanceof Step
          ? e.code
          : e instanceof BackupCryptoError
            ? 'verify_failed'
            : 'unexpected',
    };
  } finally {
    // the plaintext snapshot and its side files never outlive the backup
    for (const f of ['', '-wal', '-shm', '-journal']) fs.rmSync(snapshot + f, { force: true });
  }

  const finishedAt = clock();
  let runId: number | null = null;
  try {
    runId = appendBackupRun(
      deps.db,
      outcome.ok
        ? {
            kind,
            outcome: 'ok',
            startedAt,
            finishedAt,
            objectKey: outcome.objectKey,
            sizeBytes: outcome.sizeBytes,
            sha256: outcome.sha256,
          }
        : { kind, outcome: 'failed', startedAt, finishedAt, errorCode: outcome.code },
    );
  } catch {
    deps.log?.error('backup.record_failed', {});
  }
  const stamp = runId ?? finishedAt.getTime();
  announce(
    deps.db,
    outcome.ok ? 'backup_succeeded' : 'backup_failed',
    `backup:${outcome.ok ? 'ok' : 'failed'}:${stamp}`,
    finishedAt,
  );
  if (outcome.ok) {
    deps.log?.info('backup.ok', { kind, bytes: outcome.sizeBytes, sha256: outcome.sha256 });
    return {
      ok: true,
      objectKey: outcome.objectKey,
      sizeBytes: outcome.sizeBytes,
      sha256: outcome.sha256,
      runId,
      startedAt,
      finishedAt,
    };
  }
  deps.log?.error('backup.failed', { kind, code: outcome.code });
  return { ok: false, code: outcome.code, runId };
}

/**
 * Delete old backups by the retention policy. Only objects with OUR name shape are ever candidates.
 * A listing that fails or looks wrong deletes nothing. Call this only right after a verified backup.
 */
export async function applyRetention(
  store: ObjectStore,
  prefix: string,
  now: Date,
  log?: Logger,
): Promise<{ removed: number; kept: number } | null> {
  try {
    const listed = await store.list(prefix);
    const names = listed.flatMap((o) => {
      const n = parseKeyName(o.key, prefix);
      return n ? [n] : [];
    });
    const plan = planRetention(names, now);
    // belt and braces: the newest backup must be among the keepers, or nothing is deleted
    const newest = [...names].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (newest && !plan.keep.includes(newest.key)) return null;
    let removed = 0;
    for (const key of plan.remove) {
      await store.delete(key);
      removed += 1;
    }
    log?.info('backup.retention', { removed, kept: plan.keep.length });
    return { removed, kept: plan.keep.length };
  } catch {
    log?.warn('backup.retention_failed', {});
    return null;
  }
}

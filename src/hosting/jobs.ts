import 'server-only';
import { readBackupStatus } from '@/data/backups';
import type { Db } from '@/data/client';
import { needsStaleNotice } from '@/domain/hosting/backup-health';
import { backupDue } from '@/domain/hosting/schedule';
import { announce } from './announce';
import { applyRetention, runBackup } from './backup';
import type { Logger } from './logger';
import type { ObjectStore } from './object-store';

/**
 * The daily backup, driven by the worker's cycle (every 30 seconds it asks "is a backup due?").
 * Due means: no verified backup in the last 24 hours and no attempt in the last 30 minutes. A
 * successful backup is followed by the retention clean-up. If there is no verified backup for
 * 36 hours, one warning per day is recorded (and shown in the header). Never throws.
 */

export interface BackupJobDeps {
  db: Db;
  store: ObjectStore;
  key: Buffer;
  prefix: string;
  tmpDir: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log: Logger;
}

export type TickResult = 'ran' | 'skipped' | 'busy' | 'error';

export function createBackupJob(deps: BackupJobDeps): { tick(): Promise<TickResult> } {
  const clock = deps.clock ?? (() => new Date());
  let running = false;
  return {
    async tick() {
      if (running) return 'busy';
      running = true;
      try {
        const now = clock();
        const status = readBackupStatus(deps.db);
        if (needsStaleNotice({ ...status, now })) {
          announce(deps.db, 'backup_stale', `backup_stale:${now.toISOString().slice(0, 10)}`, now);
        }
        if (
          !backupDue({
            lastSuccessAt: status.lastSuccessAt,
            lastAttemptAt: status.lastAttemptAt,
            now,
          })
        ) {
          return 'skipped';
        }
        const result = await runBackup(
          {
            db: deps.db,
            store: deps.store,
            key: deps.key,
            prefix: deps.prefix,
            tmpDir: deps.tmpDir,
            migrationsFolder: deps.migrationsFolder,
            clock,
            log: deps.log,
          },
          'daily',
        );
        if (result.ok) await applyRetention(deps.store, deps.prefix, clock(), deps.log);
        return 'ran';
      } catch {
        deps.log.error('backup.job_error', {});
        return 'error';
      } finally {
        running = false;
      }
    },
  };
}

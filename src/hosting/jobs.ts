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
 *
 * The job also remembers its own last attempt in memory: if the database row of an attempt cannot be
 * written, the 30-minute spacing still holds (otherwise a full backup would start every cycle).
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
  let lastAttemptInMemory: string | null = null;
  return {
    async tick() {
      const now = clock();
      let status;
      try {
        status = readBackupStatus(deps.db);
        // checked first: a long-running backup must not hide the "no backup for a day and a half" notice
        if (needsStaleNotice({ ...status, now })) {
          announce(
            deps.db,
            'backup_stale',
            `backup_stale:${now.toISOString().slice(0, 10)}`,
            now,
            deps.log,
          );
        }
      } catch (e) {
        deps.log.error('backup.job_status_unreadable', {
          error: e instanceof Error ? e.name : 'unknown',
        });
        return 'error';
      }
      if (running) return 'busy';
      const lastAttemptAt =
        [status.lastAttemptAt, lastAttemptInMemory]
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null;
      if (!backupDue({ lastSuccessAt: status.lastSuccessAt, lastAttemptAt, now })) return 'skipped';
      running = true;
      lastAttemptInMemory = now.toISOString();
      try {
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
      } catch (e) {
        deps.log.error('backup.job_error', { error: e instanceof Error ? e.name : 'unknown' });
        return 'error';
      } finally {
        running = false;
      }
    },
  };
}

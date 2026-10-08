import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { appendBackupRun } from '@/data/backups';
import { createDatabase, migrateDatabase, type Db } from '@/data/client';
import { announce } from './announce';
import { applyRetention, runBackup } from './backup';
import { defaultMigrationsFolder, migrationStatus } from './migrations';
import type { ObjectStore } from './object-store';
import type { Logger } from './logger';
import { compactUtc } from '@/domain/hosting/retention';

/**
 * The explicit RELEASE step that runs at every start of the hosted container, before the web server
 * and the worker. Database migrations are applied ONLY here, and only after a verified backup:
 *
 *   new database           -> apply all migrations (nothing to protect yet)
 *   up to date             -> nothing to do
 *   migrations pending     -> verified pre-migration backup, then migrate, then check
 *   database from a newer app version -> refuse
 *
 * If the backup or the migration fails, the step reports failure and the container refuses to start.
 * The old database is untouched: SQLite applies a migration in one transaction, so a failure rolls
 * back completely. Every run is logged and announced.
 */

export interface ReleaseDeps {
  databaseFile: string;
  store: ObjectStore;
  key: Buffer;
  prefix: string;
  tmpDir: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log: Logger;
  /** Best effort: try to push the failure notice out now (the worker is not running yet). */
  deliver?: (db: Db) => Promise<void>;
}

export type ReleaseResult =
  | { ok: true; action: 'created' | 'up_to_date' | 'migrated'; applied: number }
  | { ok: false; code: 'database_newer' | 'backup_failed' | 'migration_failed' | 'unreadable' };

export async function runRelease(deps: ReleaseDeps): Promise<ReleaseResult> {
  const clock = deps.clock ?? (() => new Date());
  const folder = deps.migrationsFolder ?? defaultMigrationsFolder();
  const existed = fs.existsSync(deps.databaseFile);
  let db: Db;
  try {
    fs.mkdirSync(path.dirname(deps.databaseFile), { recursive: true });
    db = createDatabase(deps.databaseFile);
  } catch {
    deps.log.error('release.unreadable', {});
    return { ok: false, code: 'unreadable' };
  }
  const finish = async (r: ReleaseResult, notify: boolean): Promise<ReleaseResult> => {
    if (notify && deps.deliver) {
      await deps.deliver(db).catch(() => undefined);
    }
    try {
      db.$client.close();
    } catch {
      /* already closed */
    }
    return r;
  };
  try {
    const before = migrationStatus(db.$client, folder);
    if (before.unknown > 0) {
      deps.log.error('release.database_newer', {});
      return await finish({ ok: false, code: 'database_newer' }, false);
    }
    if (before.pending === 0) {
      deps.log.info('release.up_to_date', { applied: before.applied });
      return await finish({ ok: true, action: 'up_to_date', applied: before.applied }, false);
    }

    const hadData = existed && before.applied > 0;
    let preBackup: Awaited<ReturnType<typeof runBackup>> | null = null;
    if (hadData) {
      preBackup = await runBackup(
        {
          db,
          store: deps.store,
          key: deps.key,
          prefix: deps.prefix,
          tmpDir: deps.tmpDir,
          migrationsFolder: folder,
          clock,
          log: deps.log,
        },
        'pre-migration',
      );
      if (!preBackup.ok) {
        deps.log.error('release.backup_failed', { code: preBackup.code, pending: before.pending });
        // the backup step has recorded and announced `backup_failed` where the old schema allows it
        return await finish({ ok: false, code: 'backup_failed' }, true);
      }
    }

    try {
      migrateDatabase(db, folder);
    } catch (e) {
      deps.log.error('release.migration_failed', {
        error: e instanceof Error ? e.name : 'unknown',
        pending: before.pending,
      });
      announce(db, 'migration_failed', `migration_failed:${compactUtc(clock())}`, clock());
      return await finish({ ok: false, code: 'migration_failed' }, true);
    }

    const after = migrationStatus(db.$client, folder);
    const integrity = db.$client.pragma('integrity_check') as { integrity_check: string }[];
    if (after.pending !== 0 || integrity[0]?.integrity_check !== 'ok') {
      deps.log.error('release.check_failed', { pending: after.pending });
      announce(db, 'migration_failed', `migration_failed:${compactUtc(clock())}`, clock());
      return await finish({ ok: false, code: 'migration_failed' }, true);
    }
    // the pre-migration backup was taken before backup_runs existed in this file: record it now
    if (preBackup?.ok && preBackup.runId === null) {
      try {
        appendBackupRun(db, {
          kind: 'pre-migration',
          outcome: 'ok',
          startedAt: preBackup.startedAt,
          finishedAt: preBackup.finishedAt,
          objectKey: preBackup.objectKey,
          sizeBytes: preBackup.sizeBytes,
          sha256: preBackup.sha256,
        });
      } catch {
        deps.log.warn('release.record_backup_failed', {});
      }
    }
    announce(
      db,
      'migration_applied',
      `migration_applied:${after.applied}:${compactUtc(clock())}`,
      clock(),
    );
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    deps.log.info('release.migrated', { from: before.applied, to: after.applied });
    if (preBackup?.ok) await applyRetention(deps.store, deps.prefix, clock(), deps.log);
    return await finish(
      { ok: true, action: hadData ? 'migrated' : 'created', applied: after.applied },
      false,
    );
  } catch (e) {
    deps.log.error('release.unexpected', { error: e instanceof Error ? e.name : 'unknown' });
    return await finish({ ok: false, code: 'unreadable' }, false);
  }
}

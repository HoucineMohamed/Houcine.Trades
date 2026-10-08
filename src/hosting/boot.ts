import 'server-only';
import fs from 'node:fs';
import { createDatabase } from '@/data/client';
import { readHostingConfig } from './config';
import { announce } from './announce';
import { sweepStaleSnapshots } from './backup';
import { heartbeatPath, touchHeartbeat, WORKER_STALE_MS } from './health';
import type { Logger } from './logger';
import type { ObjectStore } from './object-store';
import { afterRestore } from './restore-aftercare';
import { runRelease } from './release';
import {
  applyStagedRestore,
  listBackups,
  recordRestoreResult,
  restoreIsStaged,
  type ApplyResult,
} from './restore';
import type { SetupServer } from './setup-server';
import { checkStartup, type StartupIo } from './startup';
import { Supervisor, type ChildSpec, type SupervisorOptions } from './supervisor';
import { compactUtc } from '@/domain/hosting/retention';
import type { Db } from '@/data/client';

/**
 * The start sequence of the hosted container, in this order, and each step fails CLOSED:
 *
 *   1. the start-up rules (secrets, disk, proxy setting, paper mode, backups configured)
 *   2. a staged restore, if one is waiting (before anything opens the database)
 *   3. the RELEASE step: verified backup, then migrations (the only place migrations run)
 *   4. the start-up rules again (owner exists, no migration pending)
 *   5. no owner yet: SETUP MODE (health check only) until the owner is created in the shell
 *   6. web server + worker under the supervisor
 *
 * A refusal exits with a non-zero code after a short pause (so the platform does not restart in a
 * tight loop). Nothing is spawned unless every step passed.
 */

export const EXIT_REFUSED = 78;
export const REFUSE_PAUSE_MS = 30_000;
export const OWNER_POLL_MS = 10_000;

export interface BootDeps {
  env: Record<string, string | undefined>;
  io: StartupIo;
  log: Logger;
  store: ObjectStore | null;
  key: Buffer | null;
  clock: () => Date;
  /** Waits (injected so tests do not wait). */
  sleep: (ms: number) => Promise<void>;
  startSetupServer: (o: { port: number; host: string }) => Promise<SetupServer>;
  specs: (port: number) => ChildSpec[];
  supervisor: Omit<SupervisorOptions, 'specs' | 'log' | 'onStopped' | 'heartbeat'>;
  /** Best effort: try to send out a failure notice now (the worker is not running yet). */
  deliver?: (db: Db) => Promise<void>;
  /** Called once with a function that asks everything to stop (SIGTERM / SIGINT). */
  onStopSignal: (stop: () => void) => void;
}

export async function runBoot(d: BootDeps): Promise<number> {
  const cfg = readHostingConfig(d.env);
  if (!cfg.hosted) {
    d.log.error('boot.not_hosted', { hint: 'HOSTED must be "true" in the platform environment' });
    await d.sleep(REFUSE_PAUSE_MS); // a pause, so the platform does not restart us in a tight loop
    return EXIT_REFUSED;
  }
  const refuse = async (failures: { code: string; message: string }[]): Promise<number> => {
    for (const f of failures) d.log.error('boot.refused', { code: f.code, message: f.message });
    await d.sleep(REFUSE_PAUSE_MS); // (before the stop handler exists, or a deliberate pause: kept as is)
    return EXIT_REFUSED;
  };

  const pre = checkStartup(d.env, d.io, 'before_release');
  if (!pre.ok) return refuse(pre.failures);
  const { dataDir, tmpDir, store: storeCfg } = cfg;
  if (!dataDir || !tmpDir || !storeCfg || !d.store || !d.key) {
    return refuse([
      { code: 'internal', message: 'a required setting disappeared after the check' },
    ]);
  }

  let stopping = false;
  let supervisor: Supervisor | null = null;
  let setup: SetupServer | null = null;
  let wake: (() => void) | null = null;
  d.onStopSignal(() => {
    stopping = true;
    supervisor?.requestStop();
    void setup?.close();
    wake?.(); // a stop request ends a pause at once
  });
  /** A pause that a stop request cuts short (SIGTERM must not wait out a 30 second pause). */
  const pause = (ms: number): Promise<void> =>
    stopping
      ? Promise.resolve()
      : Promise.race([
          d.sleep(ms),
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
        ]);

  // a plaintext snapshot can only be left behind by a hard kill; nothing is running yet, so none is in use
  const swept = sweepStaleSnapshots(tmpDir);
  if (swept > 0) d.log.warn('boot.swept_snapshots', { removed: swept });

  let restored: ApplyResult | null = null;
  if (restoreIsStaged(dataDir)) {
    restored = await applyStagedRestore({
      dataDir,
      databaseFile: cfg.databaseFile,
      clock: d.clock,
      log: d.log,
    });
    if (restored.applied) d.log.info('boot.restore_applied', {});
    else d.log.error('boot.restore_not_applied', { reason: restored.reason });
    // kept on the disk, so the Backups page and the header can say it (not only a line in the log)
    recordRestoreResult(
      dataDir,
      { applied: restored.applied, reason: restored.applied ? 'applied' : restored.reason },
      d.clock(),
    );
  }

  // A missing database next to existing backups is NOT a normal new install (a typo in DATABASE_URL, a
  // deleted file, an empty disk). It is still allowed to continue (setup mode must stay reachable so the
  // shell can restore), but it is said loudly, before any owner is created on an empty database.
  if (!fs.existsSync(cfg.databaseFile)) {
    try {
      const existing = await listBackups(d.store, storeCfg.prefix);
      if (existing.length > 0) {
        d.log.error('boot.database_missing_backups_exist', {
          backups: existing.length,
          hint: 'There is no database but backups exist. Restore with: npm run host:restore, then restart. Do NOT create an owner on this empty database.',
        });
      }
    } catch (e) {
      d.log.warn('boot.backup_list_failed', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  const release = await runRelease({
    databaseFile: cfg.databaseFile,
    store: d.store,
    key: d.key,
    prefix: storeCfg.prefix,
    tmpDir,
    clock: d.clock,
    log: d.log,
    deliver: d.deliver,
  });
  if (!release.ok) {
    d.log.error('boot.release_failed', { code: release.code });
    await pause(REFUSE_PAUSE_MS);
    return 1;
  }
  if (restored?.applied) {
    // the restored file is a copy of the past: end every session and halt every account until the owner looks
    const db = createDatabase(cfg.databaseFile);
    try {
      afterRestore(db, d.clock(), d.log);
      announce(db, 'restore_applied', `restore_applied:${compactUtc(d.clock())}`, d.clock(), d.log);
    } finally {
      db.$client.close();
    }
  }

  const post = checkStartup(d.env, d.io, 'after_release');
  if (!post.ok) return refuse(post.failures);

  if (post.setupMode) {
    d.log.warn('boot.setup_mode', {
      hint: 'No owner yet. Open the shell and run: npm run auth:create-owner',
    });
    try {
      setup = await d.startSetupServer({ port: cfg.port, host: '0.0.0.0' });
    } catch (e) {
      d.log.error('boot.setup_server_failed', { error: e instanceof Error ? e.name : 'unknown' });
      return refuse([{ code: 'setup_server', message: 'the health check server could not start' }]);
    }
    while (!stopping && d.io.databaseState(cfg.databaseFile).ownerExists !== true) {
      await pause(OWNER_POLL_MS);
    }
    await setup.close();
    setup = null;
    if (stopping) return 0;
    d.log.info('boot.owner_found', {});
  }
  if (stopping) return 0;

  touchHeartbeat(dataDir, d.clock()); // alive from the start; the worker keeps it fresh
  supervisor = new Supervisor({
    ...d.supervisor,
    specs: d.specs(cfg.port),
    log: d.log,
    heartbeat: {
      childName: 'worker',
      ageMs: () => {
        try {
          return Math.max(0, d.supervisor.now() - fs.statSync(heartbeatPath(dataDir)).mtimeMs);
        } catch {
          return null;
        }
      },
      maxAgeMs: WORKER_STALE_MS,
      checkEveryMs: 30_000,
      startupGraceMs: 90_000,
    },
    onStopped: () => {
      // all processes are gone: put the write-ahead log into the main file so the disk holds one clean file
      const db = createDatabase(cfg.databaseFile);
      try {
        db.$client.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.$client.close();
      }
    },
  });
  supervisor.start();
  d.log.info('boot.running', { port: cfg.port });
  return supervisor.done;
}

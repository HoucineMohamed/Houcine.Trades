import 'server-only';
import type { Db } from '@/data/client';
import type { NotificationChannel } from '@/integrations/telegram/types';
import { runWorker, type CycleReport } from '@/notifications/worker';
import { touchHeartbeat } from './health';
import type { createBackupJob } from './jobs';
import type { Logger } from './logger';

/**
 * The hosted worker: the notification cycle (collect and deliver, every 30 seconds) plus the daily
 * backup check, plus a sign of life for the supervisor and /healthz after every cycle. On SIGTERM
 * (the signal aborts) it finishes the delivery it is in, waits for a backup that is running, writes
 * the database's write-ahead log into the main file, and closes the database.
 */

export async function runHostedWorker(input: {
  db: Db;
  channel: NotificationChannel | null;
  signal: AbortSignal;
  dataDir: string;
  backupJob: ReturnType<typeof createBackupJob> | null;
  log: Logger;
  intervalMs?: number;
  /** Longest wait for a backup that is still running when we are told to stop. */
  backupWaitMs?: number;
}): Promise<void> {
  touchHeartbeat(input.dataDir); // alive from the very start, before the first cycle ends
  // One backup at a time, and the SAME promise until it ends: shutting down waits for it, a later cycle
  // that finds one running never replaces it with an instantly finished one.
  let inFlight: Promise<unknown> | null = null;
  input.log.info('worker.started', { backups: input.backupJob !== null });
  await runWorker({
    db: input.db,
    channel: input.channel,
    signal: input.signal,
    intervalMs: input.intervalMs,
    onCycle: (r: CycleReport) => {
      touchHeartbeat(input.dataDir);
      if (input.backupJob && inFlight === null) {
        // handled right here: an unhandled rejection would end the whole worker process
        inFlight = Promise.resolve()
          .then(() => input.backupJob?.tick())
          .catch(() => input.log.error('worker.backup_tick_failed', {}))
          .finally(() => {
            inFlight = null;
          });
      }
      if (r.collect?.recorded || r.deliver?.sent || r.deliver?.failed || r.errors.length > 0) {
        input.log.info('worker.cycle', {
          recorded: r.collect?.recorded ?? 0,
          sent: r.deliver?.sent ?? 0,
          failed: r.deliver?.failed ?? 0,
          problems: r.problems,
        });
      }
    },
  });
  input.log.info('worker.stopping', {});
  await Promise.race([
    (inFlight ?? Promise.resolve()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, input.backupWaitMs ?? 15_000).unref()),
  ]);
  try {
    input.db.$client.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    input.log.warn('worker.checkpoint_failed', {});
  }
  try {
    input.db.$client.close();
  } catch {
    /* already closed */
  }
  input.log.info('worker.stopped', {});
}

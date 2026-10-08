import { createBackupJob } from '@/hosting/jobs';
import { createLogger, secretsFromEnv } from '@/hosting/logger';
import { createS3Store } from '@/hosting/object-store';
import { readHostingConfig } from '@/hosting/config';
import { runHostedWorker } from '@/hosting/worker-main';
import { getChannelRuntime } from '@/notifications/runtime';
import { openDatabase } from '../auth/run';

/**
 * The hosted worker process, started by the supervisor (scripts/host/start.ts). Alerts and the daily
 * backup. Logs are JSON lines with no secrets. Stops cleanly on SIGTERM.
 */
async function main(): Promise<number> {
  const cfg = readHostingConfig(process.env);
  const log = createLogger({ service: 'worker', secrets: secretsFromEnv(process.env) });
  if (!cfg.dataDir) {
    log.error('worker.no_data_dir', {});
    return 1;
  }
  const db = openDatabase();
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  const backupJob =
    cfg.store && cfg.backupKey && cfg.tmpDir
      ? createBackupJob({
          db,
          store: createS3Store(cfg.store),
          key: cfg.backupKey,
          prefix: cfg.store.prefix,
          tmpDir: cfg.tmpDir,
          log,
        })
      : null;
  if (!backupJob) log.error('worker.backups_not_configured', {});
  await runHostedWorker({
    db,
    channel: getChannelRuntime().channel,
    signal: controller.signal,
    dataDir: cfg.dataDir,
    backupJob,
    log,
  });
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(JSON.stringify({ level: 'error', service: 'worker', event: 'worker.crashed' }));
    process.exit(1);
  });

import { runBackup } from '@/hosting/backup';
import { loadEnvFile, openDatabase } from '../auth/run';
import { hostingContext } from './run';

/** `npm run host:backup`: one extra backup right now (kind "manual"), verified like every other. */
async function main(): Promise<number> {
  loadEnvFile();
  const ctx = hostingContext('backup');
  if (!ctx) return 1;
  const db = openDatabase();
  const tmpDir = ctx.cfg.tmpDir ?? 'data/tmp';
  const result = await runBackup(
    {
      db,
      store: ctx.store,
      key: ctx.key,
      prefix: ctx.cfg.store?.prefix ?? 'backups',
      tmpDir,
      log: ctx.log,
    },
    'manual',
  );
  db.$client.close();
  if (result.ok) {
    console.log('Backup finished and verified.');
    return 0;
  }
  console.error(`The backup failed (${result.code}). See docs/deploy.md.`);
  return 1;
}

void main().then((code) => process.exit(code));

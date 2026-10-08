import { terminalIo } from '../auth/run';
import { loadEnvFile } from '../auth/run';
import { restoreFlow } from './flows';
import { hostingContext } from './run';

/**
 * `npm run host:restore`: lists the backups, asks you to choose one and to type RESTORE, downloads it
 * and checks it (decryption, integrity, migrations) into a NEW file, and stages it. The swap happens
 * at the next start of the service. `--swap-now` swaps immediately (only with the app stopped).
 */
async function main(): Promise<number> {
  loadEnvFile();
  if (!process.stdin.isTTY) {
    console.error('This needs a real terminal (it asks you to confirm).');
    return 1;
  }
  const ctx = hostingContext('restore');
  if (!ctx) return 1;
  if (!ctx.cfg.dataDir) {
    console.error('DATA_DIR must be set to the folder of the persistent disk.');
    return 1;
  }
  const args = process.argv.slice(2);
  const swapNow = args.includes('--swap-now');
  const named = args.find((a) => a.startsWith('--key='))?.slice('--key='.length) ?? null;
  return restoreFlow(terminalIo, {
    deps: {
      store: ctx.store,
      key: ctx.key,
      prefix: ctx.cfg.store?.prefix ?? 'backups',
      dataDir: ctx.cfg.dataDir,
      log: ctx.log,
    },
    databaseFile: ctx.cfg.databaseFile,
    swapNow,
    objectKey: named,
  });
}

void main().then((code) => process.exit(code));

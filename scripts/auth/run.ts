import { isHosted } from '@/auth/hosted';
import { createDatabase, assertDatabaseReady, type Db } from '@/data/client';
import { dropToDataOwner } from '@/hosting/privileges';
import { getEnv } from '@/config/env';
import { readHiddenLine, readLine } from './prompt';
import type { Io } from './flows';

/** Shared start-up for the command-line scripts: .env, database, terminal. */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: the environment may still provide the settings
  }
}

/**
 * On the hosted app the scripts are often started from a root shell. Step down to the user that owns
 * the data folder BEFORE touching the database or the restore folder, so no root-owned file can end up
 * where the app's unprivileged user cannot use it. Exits with a message if that is not possible.
 */
export function stepDownIfRoot(): void {
  const dataDir = process.env.DATA_DIR;
  if (!isHosted() || !dataDir) return;
  if (dropToDataOwner(dataDir) === 'failed') {
    console.error(
      'This script was started as root and could not switch to the app user (is the persistent disk folder owned by root? Restart the service once, then try again).',
    );
    process.exit(1);
  }
}

export function openDatabase(): Db {
  stepDownIfRoot();
  const db = createDatabase(getEnv().DATABASE_URL.replace(/^file:/, ''));
  assertDatabaseReady(db); // tells you to run "npm run db:migrate" if needed
  return db;
}

export const terminalIo: Io = {
  readSecret: readHiddenLine,
  readLine,
  print: (line = '') => console.log(line),
};

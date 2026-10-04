import { createDatabase, assertDatabaseReady, type Db } from '@/data/client';
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

export function openDatabase(): Db {
  const db = createDatabase(getEnv().DATABASE_URL.replace(/^file:/, ''));
  assertDatabaseReady(db); // tells you to run "npm run db:migrate" if needed
  return db;
}

export const terminalIo: Io = {
  readSecret: readHiddenLine,
  readLine,
  print: (line = '') => console.log(line),
};

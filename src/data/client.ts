import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getEnv } from '@/config/env';

/** Opens (and configures) a SQLite database. Use ":memory:" in tests: no file is created. */
export function createDatabase(file: string) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}

/** The database handle type that every repository function receives. */
export type Db = ReturnType<typeof createDatabase>;

/** Applies the committed migrations (the `drizzle/` folder). Used by tests and by db:migrate. */
export function migrateDatabase(db: Db, migrationsFolder = path.resolve(process.cwd(), 'drizzle')) {
  migrate(db, { migrationsFolder });
}

export class DatabaseNotReadyError extends Error {
  constructor() {
    super('The database is not set up yet. Run "npm run db:migrate" once, then reload this page.');
    this.name = 'DatabaseNotReadyError';
  }
}

export function assertDatabaseReady(db: Db): void {
  const row = db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trades'`);
  if (!row) throw new DatabaseNotReadyError();
}

const globalForDb = globalThis as unknown as { __houcineDb?: Db };

/**
 * The app's database (file from DATABASE_URL), opened once and reused. Call it lazily inside
 * request handlers, never at import time, so builds and tests never create database files.
 */
export function getDb(): Db {
  if (!globalForDb.__houcineDb) {
    const db = createDatabase(getEnv().DATABASE_URL.replace(/^file:/, ''));
    assertDatabaseReady(db);
    globalForDb.__houcineDb = db;
  }
  return globalForDb.__houcineDb;
}

/** Anything that can run SELECTs: the database itself or a transaction inside it. */
export type Reader = Pick<Db, 'select'>;

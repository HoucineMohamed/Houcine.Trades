import 'server-only';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/**
 * Which migrations does a database file have, compared with the ones committed in drizzle/?
 * Used by the start-up guard, the release step and the restore check. Read-only.
 */

export interface MigrationStatus {
  /** Migrations recorded as applied. */
  applied: number;
  /** Committed migrations the database does not have yet. */
  pending: number;
  /** Applied migrations this code does not know (the file is from a NEWER version of the app). */
  unknown: number;
  /** All committed migrations. */
  total: number;
}

export const defaultMigrationsFolder = () => path.resolve(process.cwd(), 'drizzle');

export function migrationStatus(
  sqlite: Database.Database,
  folder = defaultMigrationsFolder(),
): MigrationStatus {
  const committed = readMigrationFiles({ migrationsFolder: folder });
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const rows = hasTable
    ? (sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations').all() as {
        hash: string;
        created_at: number;
      }[])
    : [];
  const known = new Set(committed.map((m) => m.hash));
  const unknown = rows.filter((r) => !known.has(r.hash)).length;
  const lastApplied = rows.reduce((m, r) => Math.max(m, Number(r.created_at)), -1);
  // the migrator applies every committed migration newer than the newest applied one
  const pending = committed.filter((m) => m.folderMillis > lastApplied).length;
  return { applied: rows.length, pending, unknown, total: committed.length };
}

export interface FileFacts {
  integrityOk: boolean;
  foreignKeysOk: boolean;
  migrations: MigrationStatus;
}

/** Opens a database file read-only and checks it. Never writes. */
export async function inspectDatabaseFile(
  file: string,
  folder = defaultMigrationsFolder(),
): Promise<FileFacts> {
  const { default: Sqlite } = await import('better-sqlite3');
  const sqlite = new Sqlite(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma('integrity_check') as { integrity_check: string }[];
    const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
    const foreignKeysOk = (sqlite.pragma('foreign_key_check') as unknown[]).length === 0;
    return { integrityOk, foreignKeysOk, migrations: migrationStatus(sqlite, folder) };
  } finally {
    sqlite.close();
  }
}

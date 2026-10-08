import 'server-only';
import path from 'node:path';
import { isHosted } from '@/auth/hosted';
import { parseBackupKey } from './crypto';
import { parseStoreConfig, type StoreConfig } from './object-store';

/**
 * Hosting settings, read from the environment (the platform's secret store). Nothing here is
 * printed. Missing or invalid values come back as null, and the start-up check names which one.
 */

export interface HostingConfig {
  hosted: boolean;
  /** The persistent disk mount, absolute, or null. */
  dataDir: string | null;
  /** The database file, absolute. */
  databaseFile: string;
  /** Short-lived plaintext snapshots live here (inside the disk). */
  tmpDir: string | null;
  backupKey: Buffer | null;
  store: StoreConfig | null;
  /** The port the platform tells us to listen on. */
  port: number;
}

export function databaseFileFromEnv(env: Record<string, string | undefined>): string {
  const url = (env.DATABASE_URL ?? 'file:./data/houcine-trades.db').replace(/^file:/, '');
  return path.resolve(url);
}

export function readHostingConfig(env: Record<string, string | undefined>): HostingConfig {
  const rawDir = (env.DATA_DIR ?? '').trim();
  const dataDir = rawDir !== '' && path.isAbsolute(rawDir) ? path.resolve(rawDir) : null;
  const portText = (env.PORT ?? '').trim();
  const port =
    /^\d{1,5}$/.test(portText) && Number(portText) > 0 && Number(portText) < 65536
      ? Number(portText)
      : 10000;
  return {
    hosted: isHosted(env),
    dataDir,
    databaseFile: databaseFileFromEnv(env),
    tmpDir: dataDir ? path.join(dataDir, 'tmp') : null,
    // BACKUP_KEY must never be AUTH_SECRET (or any copy of it): one leak must not open both
    backupKey:
      env.BACKUP_KEY !== undefined && env.BACKUP_KEY.trim() === (env.AUTH_SECRET ?? '').trim()
        ? null
        : parseBackupKey(env.BACKUP_KEY),
    store: parseStoreConfig(env),
    port,
  };
}

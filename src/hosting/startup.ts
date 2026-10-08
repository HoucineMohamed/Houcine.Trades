import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { parseAuthEnv } from '@/auth/env';
import { mountFacts } from '@/domain/hosting/mountinfo';
import {
  evaluateStartup,
  type StartupFacts,
  type StartupResult,
} from '@/domain/hosting/startup-rules';
import { readHostingConfig } from './config';
import { defaultMigrationsFolder, migrationStatus } from './migrations';

/**
 * Gathers the facts for the start-up rules (the rules themselves are pure, in
 * src/domain/hosting/startup-rules.ts) and checks them. Reading only: nothing is created or changed
 * (the one exception is a short write test inside the data folder, removed at once).
 */

export interface StartupIo {
  /** The text of a file, or null if it cannot be read. */
  readText(file: string): string | null;
  /** Can a file be created inside this folder? */
  canWrite(dir: string): boolean;
  /** Owner and migration state of the database file (read-only), or nulls if unreadable. */
  databaseState(file: string): { ownerExists: boolean | null; migrationsPending: number | null };
}

export function realStartupIo(): StartupIo {
  return {
    readText(file) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    canWrite(dir) {
      try {
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, 'x', { mode: 0o600 });
        fs.rmSync(probe, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    databaseState(file) {
      const folder = defaultMigrationsFolder();
      if (!fs.existsSync(file)) {
        // a brand new disk: no owner yet, every migration still to apply
        try {
          return {
            ownerExists: false,
            migrationsPending: migrationStatus(new Sqlite(':memory:'), folder).pending,
          };
        } catch {
          return { ownerExists: null, migrationsPending: null };
        }
      }
      let sqlite: Sqlite.Database | null = null;
      try {
        sqlite = new Sqlite(file, { readonly: true, fileMustExist: true });
        const status = migrationStatus(sqlite, folder);
        const hasOwnerTable = sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner'")
          .get();
        const ownerExists = hasOwnerTable
          ? sqlite.prepare('SELECT 1 FROM owner LIMIT 1').get() !== undefined
          : false;
        return { ownerExists, migrationsPending: status.unknown > 0 ? null : status.pending };
      } catch {
        return { ownerExists: null, migrationsPending: null };
      } finally {
        sqlite?.close();
      }
    },
  };
}

export function collectStartupFacts(
  env: Record<string, string | undefined>,
  io: StartupIo,
): StartupFacts {
  const cfg = readHostingConfig(env);
  let authSecretValid = true;
  try {
    parseAuthEnv(env);
  } catch {
    authSecretValid = false;
  }
  let dataDirMounted: boolean | null = null;
  let dataDirReadOnly: boolean | null = null;
  let databaseInsideDataDir = false;
  if (cfg.dataDir) {
    const info = io.readText('/proc/self/mountinfo');
    if (info !== null) {
      const facts = mountFacts(info, cfg.dataDir);
      dataDirMounted = facts.mounted;
      dataDirReadOnly = facts.mounted ? facts.readOnly || !io.canWrite(cfg.dataDir) : null;
    }
    databaseInsideDataDir = cfg.databaseFile.startsWith(cfg.dataDir + path.sep);
  }
  const db = io.databaseState(cfg.databaseFile);
  return {
    hosted: cfg.hosted,
    nodeEnv: env.NODE_ENV,
    tradingMode: env.TRADING_MODE ?? 'paper',
    authSecretValid,
    trustProxyRaw: env.TRUST_PROXY,
    dataDirValid: cfg.dataDir !== null,
    dataDirMounted,
    dataDirReadOnly,
    databaseInsideDataDir,
    backupKeyValid: cfg.backupKey !== null,
    objectStoreValid: cfg.store !== null,
    ownerExists: db.ownerExists,
    migrationsPending: db.migrationsPending,
  };
}

export type StartupStage = 'before_release' | 'after_release';

/**
 * Before the release step pending migrations are expected (the release step applies them), so
 * those two codes are ignored; after it, they are refusals like everything else.
 */
export function checkStartup(
  env: Record<string, string | undefined>,
  io: StartupIo,
  stage: StartupStage,
): StartupResult {
  const result = evaluateStartup(collectStartupFacts(env, io));
  if (stage === 'after_release') return result;
  const failures = result.failures.filter(
    (f) => f.code !== 'migrations_pending' && f.code !== 'migrations_unreadable',
  );
  return { ok: failures.length === 0, failures, setupMode: false };
}

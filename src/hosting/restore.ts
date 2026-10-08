import 'server-only';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  compactUtc,
  parseBackupKey as parseKeyName,
  type BackupName,
} from '@/domain/hosting/retention';
import { BackupCryptoError, decryptBackup } from './crypto';
import { inspectDatabaseFile, type MigrationStatus } from './migrations';
import { StoreError, type ObjectStore } from './object-store';
import type { Logger } from './logger';

/**
 * Restore, in two separate steps so a live database is never swapped under a running app:
 *
 *  STAGE  (stageRestore): download the chosen backup, decrypt it (a wrong key or a damaged file is
 *         refused), and write it to a NEW file next to the database. Check it: integrity, foreign
 *         keys, and the migrations check (a file from a NEWER app version is refused). Write a marker.
 *  APPLY  (applyStagedRestore): only when no process has the database open (at the next start, before
 *         anything opens it, or from the script with --swap-now while the app is stopped). Re-checks the
 *         staged file, moves the old database aside (it is KEPT, never deleted) and puts the restored
 *         file in its place.
 *
 * Nothing here ever deletes the live database.
 */

/** A staged restore that waits longer than this is discarded instead of applied (a forgotten one must not surprise a later restart). */
export const STAGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const DIR = 'restore';
const INCOMING = 'incoming.db';
const MARKER = 'READY.json';

const markerSchema = z.object({
  objectKey: z.string().min(1).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  stagedAt: z.string().min(1),
  applied: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
type Marker = z.infer<typeof markerSchema>;

export interface RestoreDeps {
  store: ObjectStore;
  key: Buffer;
  prefix: string;
  /** The persistent disk folder (DATA_DIR). */
  dataDir: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log?: Logger;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const paths = (dataDir: string) => {
  const dir = path.join(dataDir, DIR);
  return { dir, incoming: path.join(dir, INCOMING), marker: path.join(dir, MARKER) };
};

export async function listBackups(store: ObjectStore, prefix: string): Promise<BackupName[]> {
  const listed = await store.list(prefix);
  return listed
    .flatMap((o) => {
      const n = parseKeyName(o.key, prefix);
      return n ? [n] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type StageResult =
  | { ok: true; objectKey: string; migrations: MigrationStatus }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'download_failed'
        | 'wrong_key_or_damaged'
        | 'not_a_database'
        | 'integrity_failed'
        | 'newer_than_app'
        | 'write_failed';
    };

function cleanStage(dataDir: string) {
  const p = paths(dataDir);
  for (const f of [p.marker, p.incoming, `${p.incoming}-wal`, `${p.incoming}-shm`]) {
    fs.rmSync(f, { force: true });
  }
}

export async function stageRestore(deps: RestoreDeps, objectKey: string): Promise<StageResult> {
  const clock = deps.clock ?? (() => new Date());
  // only objects with our own name shape can be restored (a typed key is never trusted)
  if (!parseKeyName(objectKey, deps.prefix)) return { ok: false, code: 'not_found' };
  const p = paths(deps.dataDir);
  cleanStage(deps.dataDir); // an earlier staging is replaced, never merged
  let blob: Buffer;
  try {
    blob = await deps.store.get(objectKey);
  } catch (e) {
    return {
      ok: false,
      code: e instanceof StoreError && e.code === 'not_found' ? 'not_found' : 'download_failed',
    };
  }
  let plain: Buffer;
  try {
    plain = gunzipSync(decryptBackup(blob, deps.key));
  } catch (e) {
    return {
      ok: false,
      code: e instanceof BackupCryptoError ? 'wrong_key_or_damaged' : 'not_a_database',
    };
  }
  if (plain.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
    return { ok: false, code: 'not_a_database' };
  }
  try {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.incoming, plain, { mode: 0o600, flag: 'wx' });
  } catch {
    cleanStage(deps.dataDir);
    return { ok: false, code: 'write_failed' };
  }
  try {
    const facts = await inspectDatabaseFile(p.incoming, deps.migrationsFolder);
    if (!facts.integrityOk || !facts.foreignKeysOk) {
      cleanStage(deps.dataDir);
      return { ok: false, code: 'integrity_failed' };
    }
    if (facts.migrations.unknown > 0) {
      cleanStage(deps.dataDir);
      return { ok: false, code: 'newer_than_app' };
    }
    // a read-only look at a WAL file may leave empty side files: remove them, refuse anything else
    fs.rmSync(`${p.incoming}-shm`, { force: true });
    if (fs.existsSync(`${p.incoming}-wal`)) {
      if (fs.statSync(`${p.incoming}-wal`).size > 0) throw new Error('wal');
      fs.rmSync(`${p.incoming}-wal`, { force: true });
    }
    const marker: Marker = {
      objectKey,
      sha256: sha256(fs.readFileSync(p.incoming)),
      stagedAt: clock().toISOString(),
      applied: facts.migrations.applied,
      pending: facts.migrations.pending,
    };
    fs.writeFileSync(p.marker, JSON.stringify(marker), { mode: 0o600 });
    deps.log?.info('restore.staged', { applied: marker.applied, pending: marker.pending });
    return { ok: true, objectKey, migrations: facts.migrations };
  } catch {
    cleanStage(deps.dataDir);
    return { ok: false, code: 'not_a_database' };
  }
}

/** Throws away a staged restore. True if there was one. */
export function cancelStagedRestore(dataDir: string): boolean {
  const had = fs.existsSync(paths(dataDir).marker) || fs.existsSync(paths(dataDir).incoming);
  cleanStage(dataDir);
  return had;
}

/** True when a restore has been staged and is waiting for the next start. */
export function restoreIsStaged(dataDir: string): boolean {
  return fs.existsSync(paths(dataDir).marker);
}

export type ApplyResult =
  | { applied: false; reason: 'nothing_staged' }
  | {
      applied: false;
      reason:
        'invalid' | 'changed' | 'integrity_failed' | 'newer_than_app' | 'swap_failed' | 'expired';
    }
  | { applied: true; keptAs: string | null; objectKey: string };

export async function applyStagedRestore(opts: {
  dataDir: string;
  databaseFile: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log?: Logger;
}): Promise<ApplyResult> {
  try {
    return await applyChecked(opts);
  } catch {
    // never throws: an unreadable staging area simply means "not applied"
    return { applied: false, reason: 'invalid' };
  }
}

async function applyChecked(opts: {
  dataDir: string;
  databaseFile: string;
  migrationsFolder?: string;
  clock?: () => Date;
  log?: Logger;
}): Promise<ApplyResult> {
  const clock = opts.clock ?? (() => new Date());
  const p = paths(opts.dataDir);
  if (!fs.existsSync(p.marker)) return { applied: false, reason: 'nothing_staged' };
  let marker: Marker;
  try {
    marker = markerSchema.parse(JSON.parse(fs.readFileSync(p.marker, 'utf8')));
  } catch {
    return { applied: false, reason: 'invalid' };
  }
  if (!fs.existsSync(p.incoming)) return { applied: false, reason: 'invalid' };
  const stagedAt = Date.parse(marker.stagedAt);
  if (!Number.isFinite(stagedAt) || clock().getTime() - stagedAt > STAGE_MAX_AGE_MS) {
    cleanStage(opts.dataDir); // forgotten: discarded, never applied by surprise
    return { applied: false, reason: 'expired' };
  }
  if (sha256(fs.readFileSync(p.incoming)) !== marker.sha256)
    return { applied: false, reason: 'changed' };
  try {
    const facts = await inspectDatabaseFile(p.incoming, opts.migrationsFolder);
    if (!facts.integrityOk || !facts.foreignKeysOk)
      return { applied: false, reason: 'integrity_failed' };
    if (facts.migrations.unknown > 0) return { applied: false, reason: 'newer_than_app' };
  } catch {
    return { applied: false, reason: 'integrity_failed' };
  }
  fs.rmSync(`${p.incoming}-shm`, { force: true });
  fs.rmSync(`${p.incoming}-wal`, { force: true });

  const live = opts.databaseFile;
  const stamp = compactUtc(clock());
  const suffixes = ['', '-wal', '-shm'];
  const moved: [string, string][] = [];
  try {
    for (const s of suffixes) {
      if (fs.existsSync(live + s)) {
        const to = `${live}${s}.before-restore-${stamp}`;
        fs.renameSync(live + s, to);
        moved.push([live + s, to]);
      }
    }
    fs.renameSync(p.incoming, live);
  } catch {
    // put everything back exactly as it was
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch {
        /* nothing more can be done here */
      }
    }
    return { applied: false, reason: 'swap_failed' };
  }
  fs.rmSync(p.marker, { force: true });
  opts.log?.info('restore.applied', {});
  return { applied: true, keptAs: moved[0]?.[1] ?? null, objectKey: marker.objectKey };
}

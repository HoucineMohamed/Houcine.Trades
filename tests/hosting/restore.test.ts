import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type Db } from '@/data/client';
import { accounts } from '@/data/schema';
import { runBackup } from '@/hosting/backup';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { createLogger } from '@/hosting/logger';
import {
  applyStagedRestore,
  cancelStagedRestore,
  listBackups,
  restoreIsStaged,
  STAGE_MAX_AGE_MS,
  stageRestore,
  type RestoreDeps,
} from '@/hosting/restore';
import { FakeObjectStore } from '../helpers/object-store';
import { folderUpTo, removeDir } from '../helpers/migrations';

let root: string;
let dataDir: string;
let liveFile: string;
let src: Db;
let store: FakeObjectStore;
let key: Buffer;
const NOW = new Date('2026-10-08T03:00:00Z');
const names = (db: Db) =>
  (db.$client.prepare('SELECT name FROM accounts ORDER BY id').all() as { name: string }[]).map(
    (r) => r.name,
  );

const rd = (over: Partial<RestoreDeps> = {}): RestoreDeps => ({
  store,
  key,
  prefix: 'backups',
  dataDir,
  clock: () => NOW,
  ...over,
});
async function backupOf(db: Db, folder?: string): Promise<string> {
  const r = await runBackup(
    {
      db,
      store,
      key,
      prefix: 'backups',
      tmpDir: path.join(root, 'tmp'),
      clock: () => NOW,
      migrationsFolder: folder,
    },
    'daily',
  );
  if (!r.ok) throw new Error(`backup failed: ${r.code}`);
  return r.objectKey;
}
function liveWith(...accountNames: string[]): Db {
  const db = createDatabase(liveFile);
  migrateDatabase(db);
  for (const n of accountNames) {
    db.insert(accounts)
      .values({ name: n, baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
      .run();
  }
  return db;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-restore-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  liveFile = path.join(dataDir, 'app.db');
  src = createDatabase(path.join(root, 'source.db'));
  migrateDatabase(src);
  src
    .insert(accounts)
    .values({ name: 'from-backup', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
    .run();
  store = new FakeObjectStore();
  key = parseBackupKey(generateBackupKey()) as Buffer;
});
afterEach(() => {
  src.$client.close();
  removeDir(root);
});

describe('restore: the round trip', () => {
  it('stages into a NEW file, checks it, and only then swaps it in; the old database is kept', async () => {
    const objectKey = await backupOf(src);
    const live = liveWith('current');
    live.$client.close();

    const staged = await stageRestore(rd(), objectKey);
    expect(staged).toMatchObject({ ok: true, objectKey });
    expect(restoreIsStaged(dataDir)).toBe(true);
    // staging does not touch the live database
    const check = createDatabase(liveFile);
    expect(names(check)).toEqual(['current']);
    check.$client.close();

    const applied = await applyStagedRestore({ dataDir, databaseFile: liveFile, clock: () => NOW });
    expect(applied).toMatchObject({ applied: true, objectKey });
    const after = createDatabase(liveFile);
    expect(names(after)).toEqual(['from-backup']);
    expect(after.$client.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    after.$client.close();
    // the old database was moved aside, not deleted
    const kept = (applied as { keptAs: string }).keptAs;
    expect(kept).toContain('.before-restore-20261008T030000Z');
    const old = createDatabase(kept);
    expect(names(old)).toEqual(['current']);
    old.$client.close();
    expect(restoreIsStaged(dataDir)).toBe(false);
  });

  it('works on an empty disk (a fresh container) and lists backups newest first', async () => {
    const k1 = await backupOf(src);
    const list = await listBackups(store, 'backups');
    expect(list.map((b) => b.key)).toEqual([k1]);
    await stageRestore(rd(), k1);
    const applied = await applyStagedRestore({ dataDir, databaseFile: liveFile });
    expect(applied).toMatchObject({ applied: true, keptAs: null });
    const db = createDatabase(liveFile);
    expect(names(db)).toEqual(['from-backup']);
    db.$client.close();
  });
});

describe('restore: bad backups are refused and nothing is staged', () => {
  const nothingLeft = () => {
    expect(restoreIsStaged(dataDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'restore', 'incoming.db'))).toBe(false);
  };

  it('a wrong key', async () => {
    const objectKey = await backupOf(src);
    const r = await stageRestore(
      rd({ key: parseBackupKey(generateBackupKey()) as Buffer }),
      objectKey,
    );
    expect(r).toEqual({ ok: false, code: 'wrong_key_or_damaged' });
    nothingLeft();
  });

  it('a corrupted object', async () => {
    const objectKey = await backupOf(src);
    store.corruptOnGet = true;
    expect(await stageRestore(rd(), objectKey)).toEqual({
      ok: false,
      code: 'wrong_key_or_damaged',
    });
    nothingLeft();
  });

  it('a truncated object', async () => {
    const objectKey = await backupOf(src);
    const blob = store.objects.get(objectKey) as Buffer;
    store.objects.set(objectKey, blob.subarray(0, blob.length - 20));
    expect(await stageRestore(rd(), objectKey)).toEqual({
      ok: false,
      code: 'wrong_key_or_damaged',
    });
    nothingLeft();
  });

  it('a missing object, a download problem, and a name that is not one of ours', async () => {
    expect(await stageRestore(rd(), 'backups/20200101T000000Z-daily-m7.htbk')).toEqual({
      ok: false,
      code: 'not_found',
    });
    const objectKey = await backupOf(src);
    store.failNext.set('get', 'network');
    expect(await stageRestore(rd(), objectKey)).toEqual({ ok: false, code: 'download_failed' });
    expect(await stageRestore(rd(), '../../etc/passwd')).toEqual({ ok: false, code: 'not_found' });
    expect(await stageRestore(rd(), 'other/20200101T000000Z-daily-m7.htbk')).toEqual({
      ok: false,
      code: 'not_found',
    });
    nothingLeft();
  });

  it('a file that decrypts but is not a database', async () => {
    const { encryptBackup } = await import('@/hosting/crypto');
    const { gzipSync } = await import('node:zlib');
    const k = 'backups/20261008T030000Z-daily-m7.htbk';
    store.objects.set(
      k,
      encryptBackup(
        gzipSync(Buffer.from('just some text, not sqlite at all')),
        key,
        '20261008T030000Z-daily-m7.htbk',
      ),
    );
    expect(await stageRestore(rd(), k)).toEqual({ ok: false, code: 'not_a_database' });
    nothingLeft();
  });

  it('a backup from a NEWER version of the app', async () => {
    src.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-the-future', 9999999999999)",
      )
      .run();
    const objectKey = await backupOf(src);
    expect(await stageRestore(rd(), objectKey)).toEqual({ ok: false, code: 'newer_than_app' });
    nothingLeft();
  });
});

describe('restore: apply is careful', () => {
  it('does nothing when nothing is staged', async () => {
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'nothing_staged',
    });
  });

  it('refuses a staged file that changed after it was checked', async () => {
    const objectKey = await backupOf(src);
    liveWith('current').$client.close();
    await stageRestore(rd(), objectKey);
    fs.appendFileSync(path.join(dataDir, 'restore', 'incoming.db'), 'x');
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'changed',
    });
    const db = createDatabase(liveFile);
    expect(names(db)).toEqual(['current']); // untouched
    db.$client.close();
  });

  it('refuses a damaged marker', async () => {
    const objectKey = await backupOf(src);
    await stageRestore(rd(), objectKey);
    fs.writeFileSync(path.join(dataDir, 'restore', 'READY.json'), '{"objectKey":"x"}');
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'invalid',
    });
  });

  it('puts the old database back if the swap fails half way', async () => {
    const objectKey = await backupOf(src);
    liveWith('current').$client.close();
    await stageRestore(rd(), objectKey);
    const real = fs.renameSync.bind(fs);
    let n = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      n += 1;
      if (n >= 2 && String(from).endsWith('incoming.db')) throw new Error('disk problem');
      return real(from, to);
    });
    try {
      const r = await applyStagedRestore({ dataDir, databaseFile: liveFile });
      expect(r).toEqual({ applied: false, reason: 'swap_failed' });
    } finally {
      spy.mockRestore();
    }
    const db = createDatabase(liveFile);
    expect(names(db)).toEqual(['current']); // exactly as before
    db.$client.close();
  });

  it('never throws, even when the staged file cannot be read', async () => {
    const objectKey = await backupOf(src);
    await stageRestore(rd(), objectKey);
    fs.rmSync(path.join(dataDir, 'restore', 'incoming.db'));
    fs.mkdirSync(path.join(dataDir, 'restore', 'incoming.db'));
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'invalid',
    });
  });
});

describe('a staged restore cannot surprise a later restart', () => {
  it('can be cancelled, and then nothing is applied', async () => {
    const objectKey = await backupOf(src);
    liveWith('current').$client.close();
    await stageRestore(rd(), objectKey);
    expect(cancelStagedRestore(dataDir)).toBe(true);
    expect(restoreIsStaged(dataDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'restore', 'incoming.db'))).toBe(false);
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'nothing_staged',
    });
    expect(cancelStagedRestore(dataDir)).toBe(false); // nothing left to cancel
  });

  it('is discarded, not applied, when it waited too long (a forgotten staging)', async () => {
    const objectKey = await backupOf(src);
    liveWith('current').$client.close();
    await stageRestore(rd(), objectKey); // staged at NOW
    const later = new Date(NOW.getTime() + STAGE_MAX_AGE_MS + 1000);
    expect(
      await applyStagedRestore({ dataDir, databaseFile: liveFile, clock: () => later }),
    ).toEqual({ applied: false, reason: 'expired' });
    expect(restoreIsStaged(dataDir)).toBe(false); // gone
    const db = createDatabase(liveFile);
    expect(names(db)).toEqual(['current']); // untouched
    db.$client.close();
  });

  it('is still applied just inside the limit', async () => {
    const objectKey = await backupOf(src);
    await stageRestore(rd(), objectKey);
    const inside = new Date(NOW.getTime() + STAGE_MAX_AGE_MS - 1000);
    expect(
      await applyStagedRestore({ dataDir, databaseFile: liveFile, clock: () => inside }),
    ).toMatchObject({ applied: true });
  });
});

describe('restore of an older schema', () => {
  it('works: the restored file is older, and the migrations check says what is pending', async () => {
    const old = folderUpTo('0004_analyst');
    try {
      const oldDb = createDatabase(path.join(root, 'old.db'));
      migrateDatabase(oldDb, old);
      oldDb
        .insert(accounts)
        .values({
          name: 'from-old-schema',
          baseCurrency: 'EUR',
          startingBalance: '1',
          createdAt: 't',
        })
        .run();
      const objectKey = await backupOf(oldDb, old);
      oldDb.$client.close();
      expect(objectKey).toContain('-m5.htbk');
      const staged = await stageRestore(rd(), objectKey);
      expect(staged).toMatchObject({ ok: true });
      if (staged.ok)
        expect(staged.migrations).toMatchObject({ applied: 5, pending: 2, unknown: 0 });
      expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toMatchObject({
        applied: true,
      });
      const db = createDatabase(liveFile);
      expect(names(db)).toEqual(['from-old-schema']);
      db.$client.close();
    } finally {
      removeDir(old);
    }
  });
});

describe('restore logs', () => {
  it('say nothing but counts', async () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    const objectKey = await backupOf(src);
    await stageRestore(rd({ log }), objectKey);
    expect(lines.join('\n')).not.toContain(objectKey);
    expect(lines.join('\n')).toContain('restore.staged');
  });
});

describe('hardening found by the reviews', () => {
  it('an object swapped for another valid backup is refused (the name is authenticated)', async () => {
    const objectKey = await backupOf(src);
    const blob = store.objects.get(objectKey) as Buffer;
    const other = 'backups/20270101T000000Z-daily-m7.htbk'; // looks newer, holds the older content
    store.objects.set(other, Buffer.from(blob));
    expect(await stageRestore(rd(), other)).toEqual({ ok: false, code: 'wrong_key_or_damaged' });
    expect(restoreIsStaged(dataDir)).toBe(false);
  });

  it('the kept old database keeps its side files paired with it (name-wal, name-shm)', async () => {
    const objectKey = await backupOf(src);
    const live = liveWith('current');
    live.$client.pragma('wal_checkpoint(TRUNCATE)');
    live.$client.close();
    fs.writeFileSync(`${liveFile}-wal`, '');
    fs.writeFileSync(`${liveFile}-shm`, '');
    await stageRestore(rd(), objectKey);
    const applied = await applyStagedRestore({ dataDir, databaseFile: liveFile, clock: () => NOW });
    const kept = (applied as { keptAs: string }).keptAs;
    expect(fs.existsSync(`${kept}-wal`)).toBe(true);
    expect(fs.existsSync(`${kept}-shm`)).toBe(true);
    const old = createDatabase(kept);
    expect(names(old)).toEqual(['current']);
    old.$client.close();
  });

  it('the staged marker is written in one step (no temporary file is left)', async () => {
    const objectKey = await backupOf(src);
    await stageRestore(rd(), objectKey);
    expect(fs.readdirSync(path.join(dataDir, 'restore')).sort()).toEqual([
      'READY.json',
      'incoming.db',
    ]);
  });

  it('an unreadable marker is cleaned up, so it does not fail at every start', async () => {
    const objectKey = await backupOf(src);
    await stageRestore(rd(), objectKey);
    fs.writeFileSync(path.join(dataDir, 'restore', 'READY.json'), '{ not json');
    expect(await applyStagedRestore({ dataDir, databaseFile: liveFile })).toEqual({
      applied: false,
      reason: 'invalid',
    });
    expect(restoreIsStaged(dataDir)).toBe(false);
  });

  it('a failed apply is remembered on the disk and cancel clears it', async () => {
    const { recordRestoreResult, readRestoreFailure } = await import('@/hosting/restore');
    expect(readRestoreFailure(dataDir)).toBeNull();
    recordRestoreResult(dataDir, { applied: false, reason: 'changed' }, NOW);
    expect(readRestoreFailure(dataDir)).toEqual({ at: NOW.toISOString(), reason: 'changed' });
    recordRestoreResult(dataDir, { applied: true, reason: 'applied' }, NOW);
    expect(readRestoreFailure(dataDir)).toBeNull();
    recordRestoreResult(dataDir, { applied: false, reason: 'expired' }, NOW);
    expect(cancelStagedRestore(dataDir)).toBe(true);
    expect(readRestoreFailure(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'restore', 'LAST_RESULT.json'), 'garbage');
    expect(readRestoreFailure(dataDir)).toBeNull(); // unreadable is never a crash
  });
});

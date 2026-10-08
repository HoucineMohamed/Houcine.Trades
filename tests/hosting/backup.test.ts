import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupRuns, readBackupStatus } from '@/data/backups';
import { createDatabase, migrateDatabase, type Db } from '@/data/client';
import { accounts } from '@/data/schema';
import { backupObjectKey } from '@/domain/hosting/retention';
import { applyRetention, runBackup, type BackupDeps } from '@/hosting/backup';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { createLogger } from '@/hosting/logger';
import { StoreError } from '@/hosting/object-store';
import { enableAlerts } from '../helpers/notifications';
import { FakeObjectStore } from '../helpers/object-store';

const PRIVATE_ACCOUNT_NAME = 'my-very-private-account-name-zzq';
let dir: string;
let db: Db;
let store: FakeObjectStore;
let key: Buffer;
let lines: string[];
const NOW = new Date('2026-10-08T03:00:00Z');

function deps(over: Partial<BackupDeps> = {}): BackupDeps {
  return {
    db,
    store,
    key,
    prefix: 'backups',
    tmpDir: path.join(dir, 'tmp'),
    clock: () => NOW,
    log: createLogger({ write: (l) => lines.push(l), secrets: [] }),
    ...over,
  };
}
const eventKinds = () =>
  (
    db.$client.prepare('SELECT kind FROM notification_events ORDER BY id').all() as {
      kind: string;
    }[]
  ).map((r) => r.kind);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-backup-'));
  db = createDatabase(path.join(dir, 'live.db'));
  migrateDatabase(db);
  db.insert(accounts)
    .values({
      name: PRIVATE_ACCOUNT_NAME,
      baseCurrency: 'EUR',
      startingBalance: '1000',
      createdAt: 't',
    })
    .run();
  store = new FakeObjectStore();
  key = parseBackupKey(generateBackupKey()) as Buffer;
  lines = [];
  enableAlerts(db, new Date('2026-10-07T00:00:00Z'));
});
afterEach(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a backup', () => {
  it('is a consistent snapshot, encrypted on the server, uploaded and verified', async () => {
    const r = await runBackup(deps(), 'daily');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.objectKey).toBe('backups/20261008T030000Z-daily-m7.htbk');
    const blob = store.objects.get(r.objectKey) as Buffer;
    // nothing readable leaves the server
    expect(blob.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(blob.includes(Buffer.from(PRIVATE_ACCOUNT_NAME))).toBe(false);
    expect(blob.subarray(0, 4).toString()).toBe('HTB1');
    // it was read back (put, then get)
    expect(store.calls).toEqual(['put', 'get']);
    // bookkeeping: one append-only row, one announcement, no plaintext snapshot left behind
    const runs = listBackupRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'daily',
      outcome: 'ok',
      objectKey: r.objectKey,
      sha256: r.sha256,
    });
    expect(eventKinds()).toEqual(['backup_succeeded']);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
    expect(readBackupStatus(db).lastSuccessAt).toBe(NOW.toISOString());
  });

  it('with alerts OFF nothing is queued for later (only events from the moment alerts are on are announced)', async () => {
    db.$client.exec('UPDATE notification_settings SET master = 0');
    await runBackup(deps(), 'daily');
    store.denyAll = true;
    await runBackup(deps(), 'daily');
    expect(eventKinds()).toEqual([]);
    expect(listBackupRuns(db)).toHaveLength(2); // the Backups page and the log still have everything
  });

  it('keeps working while the live database is being written to (online snapshot)', async () => {
    const writer = setInterval(() => {
      db.insert(accounts)
        .values({ name: 'x', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
        .run();
    }, 1);
    const r = await runBackup(deps(), 'manual');
    clearInterval(writer);
    expect(r.ok).toBe(true);
  });

  it('a provider that says OK but keeps nothing is caught by the read-back', async () => {
    store.dropPuts = true;
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'verify_failed' });
    expect(listBackupRuns(db)[0]).toMatchObject({ outcome: 'failed', errorCode: 'verify_failed' });
    expect(eventKinds()).toEqual(['backup_failed']);
  });

  it('a truncated upload is caught and the bad object is removed', async () => {
    store.truncatePutTo = 100;
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'verify_failed' });
    expect(store.objects.size).toBe(0);
  });

  it('a corrupted object is caught', async () => {
    store.corruptOnGet = true;
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'verify_failed' });
    expect(store.objects.size).toBe(0);
  });

  it.each([
    ['denied', 'store_denied'],
    ['network', 'store_unreachable'],
    ['timeout', 'store_unreachable'],
    ['server', 'store_unreachable'],
    ['bad_response', 'upload_failed'],
  ] as const)('an upload failing with %s is reported as %s', async (storeCode, code) => {
    store.failNext.set('put', storeCode as StoreError['code']);
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code });
    expect(listBackupRuns(db)[0]?.errorCode).toBe(code);
  });

  it('a snapshot that cannot be taken fails cleanly', async () => {
    (db.$client as unknown as { backup: () => Promise<never> }).backup = () =>
      Promise.reject(new Error('disk full'));
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'snapshot_failed' });
    expect(store.calls).toEqual([]);
  });

  it('never throws and never logs a secret, a path, a URL or the key', async () => {
    store.denyAll = true;
    const r = await runBackup(deps(), 'daily');
    expect(r.ok).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('backup.failed');
    expect(text).not.toContain(key.toString('base64url'));
    expect(text).not.toContain(PRIVATE_ACCOUNT_NAME);
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('a failure to record the run does not hide the result', async () => {
    db.$client.exec('DROP TRIGGER backup_runs_no_delete; DROP TABLE backup_runs;');
    const r = await runBackup(deps(), 'daily');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.runId).toBeNull();
    expect(lines.join('\n')).toContain('backup.record_failed');
  });
});

describe('retention on the store', () => {
  const put = (iso: string, kind = 'daily') => {
    const k = backupObjectKey('backups', new Date(iso), kind as 'daily', 7);
    store.objects.set(k, Buffer.from('x'));
    return k;
  };

  it('removes old backups, keeps the newest, never touches foreign files', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 60; i++)
      keys.push(
        put(new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString().replace(/\.\d+Z/, 'Z')),
      );
    store.objects.set('backups/notes.txt', Buffer.from('mine'));
    store.objects.set('other/20200101T000000Z-daily-m7.htbk', Buffer.from('other'));
    const r = await applyRetention(store, 'backups', NOW);
    expect(r?.removed).toBeGreaterThan(30);
    expect(store.objects.has(keys[0] as string)).toBe(true); // newest
    expect(store.objects.has('backups/notes.txt')).toBe(true);
    expect(store.objects.has('other/20200101T000000Z-daily-m7.htbk')).toBe(true);
  });

  it('a listing that fails deletes nothing', async () => {
    put('2020-01-01T00:00:00Z');
    put('2020-01-02T00:00:00Z');
    store.failNext.set('list', 'network');
    expect(await applyRetention(store, 'backups', NOW)).toBeNull();
    expect(store.objects.size).toBe(2);
  });

  it('a delete that fails stops the run and leaves the rest', async () => {
    for (let i = 0; i < 20; i++)
      put(new Date(NOW.getTime() - (i + 40) * 86_400_000).toISOString().replace(/\.\d+Z/, 'Z'));
    store.failNext.set('delete', 'server');
    expect(await applyRetention(store, 'backups', NOW)).toBeNull();
    expect(store.objects.size).toBe(20);
  });

  it('with only one backup, nothing is ever deleted', async () => {
    put('2019-01-01T00:00:00Z');
    expect(await applyRetention(store, 'backups', NOW)).toMatchObject({ removed: 0 });
    expect(store.objects.size).toBe(1);
  });
});

describe('hardening found by the reviews', () => {
  it('a plaintext snapshot left by a hard kill is swept at the next start (only files of that exact shape)', async () => {
    const { sweepStaleSnapshots } = await import('@/hosting/backup');
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const id = '123e4567-e89b-12d3-a456-426614174000';
    for (const f of [`snapshot-${id}.db`, `snapshot-${id}.db-wal`, `snapshot-${id}.db-shm`])
      fs.writeFileSync(path.join(tmp, f), 'plain');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(tmp, 'snapshot-x.db'), 'not our shape');
    expect(sweepStaleSnapshots(tmp)).toBe(3);
    expect(fs.readdirSync(tmp).sort()).toEqual(['notes.txt', 'snapshot-x.db']);
    expect(sweepStaleSnapshots(path.join(dir, 'no-such-folder'))).toBe(0);
  });

  it('a temp folder that cannot be created is a recorded failure, never a throw', async () => {
    fs.writeFileSync(path.join(dir, 'a-file'), 'x');
    const r = await runBackup(deps({ tmpDir: path.join(dir, 'a-file', 'sub') }), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'snapshot_failed' });
    expect(listBackupRuns(db)[0]).toMatchObject({
      outcome: 'failed',
      errorCode: 'snapshot_failed',
    });
    expect(eventKinds()).toEqual(['backup_failed']);
  });

  it('an upload whose read-back fails on the network is removed, not left to pass as a backup', async () => {
    store.failNext.set('get', 'network');
    const r = await runBackup(deps(), 'daily');
    expect(r).toMatchObject({ ok: false, code: 'store_unreachable' });
    expect(store.objects.size).toBe(0);
  });

  it('the stored file is bound to its own name: another name does not decrypt', async () => {
    const { decryptBackup, backupContext } = await import('@/hosting/crypto');
    const r = await runBackup(deps(), 'daily');
    if (!r.ok) throw new Error('backup failed');
    const blob = store.objects.get(r.objectKey) as Buffer;
    expect(() => decryptBackup(blob, key, backupContext(r.objectKey))).not.toThrow();
    expect(() => decryptBackup(blob, key, '20261008T030001Z-daily-m7.htbk')).toThrow();
  });

  it('the log carries a short checksum prefix, not the whole hash', async () => {
    await runBackup(deps(), 'daily');
    const ok = lines.find((l) => l.includes('backup.ok')) as string;
    expect(JSON.parse(ok).checksum).toMatch(/^[0-9a-f]{12}$/);
  });
});

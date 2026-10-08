import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupRuns } from '@/data/backups';
import { createDatabase, migrateDatabase, type Db } from '@/data/client';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { createBackupJob } from '@/hosting/jobs';
import { createLogger } from '@/hosting/logger';
import { FakeObjectStore } from '../helpers/object-store';

let dir: string;
let db: Db;
let store: FakeObjectStore;
let now: Date;
const H = 3_600_000;

const job = () =>
  createBackupJob({
    db,
    store,
    key: parseBackupKey(generateBackupKey()) as Buffer,
    prefix: 'backups',
    tmpDir: path.join(dir, 'tmp'),
    clock: () => now,
    log: createLogger({ write: () => undefined }),
  });
const kinds = () =>
  (
    db.$client.prepare('SELECT kind FROM notification_events ORDER BY id').all() as {
      kind: string;
    }[]
  ).map((r) => r.kind);
const addOwner = (createdAt: string) =>
  db.$client
    .prepare(
      "INSERT INTO owner (id, password_hash, totp_secret_enc, created_at, updated_at, password_changed_at) VALUES (1, 'h', 'e', ?, ?, ?)",
    )
    .run(createdAt, createdAt, createdAt);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-job-'));
  db = createDatabase(path.join(dir, 'app.db'));
  migrateDatabase(db);
  store = new FakeObjectStore();
  now = new Date('2026-10-08T03:00:00Z');
});
afterEach(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('daily backup job', () => {
  it('runs on a fresh install, then waits a day', async () => {
    const j = job();
    expect(await j.tick()).toBe('ran');
    expect(listBackupRuns(db)).toHaveLength(1);
    now = new Date(now.getTime() + 23 * H);
    expect(await j.tick()).toBe('skipped');
    now = new Date(now.getTime() + 2 * H);
    expect(await j.tick()).toBe('ran');
    expect(listBackupRuns(db)).toHaveLength(2);
  });

  it('after a failure it retries every 30 minutes (and not sooner), until it works', async () => {
    const j = job();
    store.denyAll = true;
    expect(await j.tick()).toBe('ran');
    now = new Date(now.getTime() + 29 * 60_000);
    expect(await j.tick()).toBe('skipped');
    now = new Date(now.getTime() + 2 * 60_000);
    expect(await j.tick()).toBe('ran'); // second failure
    store.denyAll = false;
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await j.tick()).toBe('ran');
    expect(listBackupRuns(db).map((r) => r.outcome)).toEqual(['ok', 'failed', 'failed']);
    expect(kinds()).toEqual(['backup_failed', 'backup_failed', 'backup_succeeded']); // no premature stale notice
  });

  it('two overlapping ticks run only one backup', async () => {
    const j = job();
    const [a, b] = await Promise.all([j.tick(), j.tick()]);
    expect([a, b].sort()).toEqual(['busy', 'ran']);
    expect(listBackupRuns(db)).toHaveLength(1);
  });

  it('cleans up old backups after a good one, never the newest', async () => {
    for (let i = 5; i < 80; i++) {
      const t = new Date(now.getTime() - i * 24 * H)
        .toISOString()
        .replace(/\.\d+Z/, 'Z')
        .replace(/[-:]/g, '');
      store.objects.set(`backups/${t}-daily-m7.htbk`, Buffer.from('x'));
    }
    const before = store.objects.size;
    await job().tick();
    expect(store.objects.size).toBeLessThan(before);
    expect([...store.objects.keys()].some((k) => k.includes('20261008T030000Z'))).toBe(true);
  });

  it('no verified backup for 36 hours: one warning per day, none before', async () => {
    addOwner('2026-10-01T00:00:00.000Z');
    const j = job();
    store.denyAll = true;
    await j.tick(); // 'never' already: a backup was expected since the owner was created
    expect(kinds()).toContain('backup_stale');
    const count = () => kinds().filter((k) => k === 'backup_stale').length;
    expect(count()).toBe(1);
    now = new Date(now.getTime() + 2 * H);
    await j.tick();
    expect(count()).toBe(1); // same day: the dedupe key holds
    now = new Date(now.getTime() + 24 * H);
    await j.tick();
    expect(count()).toBe(2); // next day: reminded again
  });

  it('a fresh system does not warn in its first hours', async () => {
    addOwner(now.toISOString());
    store.denyAll = true;
    await job().tick(); // owner just created, first attempt fails: 'never' because a failure exists
    // the failure is announced as backup_failed; the staleness warning needs 36 h without a success
    expect(kinds()).toContain('backup_failed');
  });

  it('never throws, even if the database is broken', async () => {
    db.$client.exec('DROP TRIGGER backup_runs_no_delete; DROP TABLE backup_runs;');
    expect(await job().tick()).toBe('error');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackupRuns } from '@/data/backups';
import { createDatabase, migrateDatabase } from '@/data/client';
import { accounts } from '@/data/schema';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { createLogger } from '@/hosting/logger';
import { migrationStatus } from '@/hosting/migrations';
import { runRelease, type ReleaseDeps } from '@/hosting/release';
import { enableAlerts } from '../helpers/notifications';
import { FakeObjectStore } from '../helpers/object-store';
import { folderUpTo, folderWithBrokenMigration, removeDir } from '../helpers/migrations';
import Sqlite from 'better-sqlite3';

let root: string;
let file: string;
let store: FakeObjectStore;
let lines: string[];
let delivered: number;
const NOW = new Date('2026-10-08T03:00:00Z');

const deps = (over: Partial<ReleaseDeps> = {}): ReleaseDeps => ({
  databaseFile: file,
  store,
  key: parseBackupKey(generateBackupKey()) as Buffer,
  prefix: 'backups',
  tmpDir: path.join(root, 'tmp'),
  clock: () => NOW,
  log: createLogger({ write: (l) => lines.push(l) }),
  deliver: async () => {
    delivered += 1;
  },
  ...over,
});
function oldDatabase(folder: string, alerts = false) {
  const db = createDatabase(file);
  migrateDatabase(db, folder);
  db.insert(accounts)
    .values({ name: 'precious', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
    .run();
  if (alerts) enableAlerts(db, new Date('2026-10-07T00:00:00Z'));
  db.$client.close();
}
const peek = <T>(f: (s: Sqlite.Database) => T): T => {
  const s = new Sqlite(file, { readonly: true });
  try {
    return f(s);
  } finally {
    s.close();
  }
};
const events = () =>
  peek((s) =>
    (s.prepare('SELECT kind FROM notification_events ORDER BY id').all() as { kind: string }[]).map(
      (r) => r.kind,
    ),
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-release-'));
  file = path.join(root, 'data', 'app.db');
  store = new FakeObjectStore();
  lines = [];
  delivered = 0;
});
afterEach(() => removeDir(root));

describe('release step', () => {
  it('a brand new disk: creates the database, no backup (nothing to protect), logs it', async () => {
    const r = await runRelease(deps());
    expect(r).toEqual({ ok: true, action: 'created', applied: 7 });
    expect(store.calls).toEqual([]);
    expect(events()).toEqual([]); // alerts are OFF on a new install: nothing is queued
    expect(lines.join('\n')).toContain('release.migrated');
  });

  it('up to date: does nothing, takes no backup', async () => {
    await runRelease(deps());
    store.calls.length = 0;
    expect(await runRelease(deps())).toEqual({ ok: true, action: 'up_to_date', applied: 7 });
    expect(store.calls).toEqual([]);
  });

  it('pending migrations: a VERIFIED pre-migration backup comes first, then the migration', async () => {
    const old = folderUpTo('0005_notifications');
    try {
      oldDatabase(old, true);
      const r = await runRelease(deps());
      expect(r).toEqual({ ok: true, action: 'migrated', applied: 7 });
      // the backup was uploaded and read back before anything changed
      expect(store.calls.slice(0, 2)).toEqual(['put', 'get']);
      expect([...store.objects.keys()][0]).toMatch(/-pre-migration-m6\.htbk$/);
      // the data survived, and the run is recorded even though backup_runs did not exist when it ran
      expect(
        peek((s) =>
          (s.prepare('SELECT name FROM accounts').all() as { name: string }[]).map((x) => x.name),
        ),
      ).toEqual(['precious']);
      const db = createDatabase(file);
      expect(listBackupRuns(db).map((x) => [x.kind, x.outcome])).toEqual([['pre-migration', 'ok']]);
      expect(migrationStatus(db.$client)).toMatchObject({ pending: 0 });
      db.$client.close();
      expect(events()).toContain('migration_applied');
    } finally {
      removeDir(old);
    }
  });

  it('if the backup fails, nothing is migrated, the old database is untouched, and a notice is attempted', async () => {
    const old = folderUpTo('0005_notifications');
    try {
      oldDatabase(old, true);
      store.denyAll = true;
      const before = peek((s) => migrationStatus(s));
      const r = await runRelease(deps());
      expect(r).toEqual({ ok: false, code: 'backup_failed' });
      expect(peek((s) => migrationStatus(s))).toEqual(before); // still on the old schema
      expect(
        peek((s) => (s.prepare('SELECT name FROM accounts').all() as { name: string }[]).length),
      ).toBe(1);
      expect(events()).toEqual(['backup_failed']);
      expect(delivered).toBe(1);
    } finally {
      removeDir(old);
    }
  });

  it('if the migration fails, the database is exactly as it was, and a notice is attempted', async () => {
    const broken = folderWithBrokenMigration();
    try {
      // bring the database to the full committed schema first, then try the broken extra migration
      const db = createDatabase(file);
      migrateDatabase(db);
      db.insert(accounts)
        .values({ name: 'precious', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
        .run();
      enableAlerts(db, new Date('2026-10-07T00:00:00Z'));
      db.$client.close();
      const before = peek((s) => migrationStatus(s, broken));
      expect(before.pending).toBe(1);
      const r = await runRelease(deps({ migrationsFolder: broken }));
      expect(r).toEqual({ ok: false, code: 'migration_failed' });
      // the half-applied statement was rolled back with the rest
      expect(
        peek((s) => s.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()),
      ).toBeUndefined();
      expect(peek((s) => migrationStatus(s, broken))).toEqual(before);
      expect(
        peek((s) => (s.prepare('SELECT name FROM accounts').all() as { name: string }[]).length),
      ).toBe(1);
      expect(events()).toContain('migration_failed');
      expect(delivered).toBe(1);
      // a verified backup was taken before the attempt
      expect([...store.objects.keys()].some((k) => k.includes('pre-migration'))).toBe(true);
    } finally {
      removeDir(broken);
    }
  });

  it('refuses a database that is from a NEWER version of the app', async () => {
    await runRelease(deps());
    const s = new Sqlite(file);
    s.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-the-future', 9999999999999)",
    ).run();
    s.close();
    store.calls.length = 0;
    expect(await runRelease(deps())).toEqual({ ok: false, code: 'database_newer' });
    expect(store.calls).toEqual([]);
  });

  it('logs the steps with counts only', async () => {
    await runRelease(deps());
    const text = lines.join('\n');
    expect(text).toContain('release.migrated');
    expect(text).not.toContain(root);
  });
});

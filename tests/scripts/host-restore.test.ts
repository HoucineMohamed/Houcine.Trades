import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Db } from '@/data/client';
import { accounts } from '@/data/schema';
import { runBackup } from '@/hosting/backup';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { restoreIsStaged } from '@/hosting/restore';
import {
  CONFIRM_RESTORE,
  CONFIRM_STOPPED,
  restoreFlow,
  type RestoreFlowOptions,
} from '../../scripts/host/flows';
import { FakeObjectStore } from '../helpers/object-store';

let root: string;
let dataDir: string;
let dbFile: string;
let src: Db;
let store: FakeObjectStore;
let key: Buffer;
let objectKey: string;
let out: string[];
const NOW = new Date('2026-10-08T03:00:00Z');

function io(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    readSecret: async () => {
      throw new Error('no secret is ever asked here');
    },
    readLine: async (prompt: string) => {
      asked.push(prompt);
      return answers.shift() ?? '';
    },
    print: (line = '') => void out.push(line),
  };
}
const opts = (over: Partial<RestoreFlowOptions> = {}): RestoreFlowOptions => ({
  deps: { store, key, prefix: 'backups', dataDir, clock: () => NOW },
  databaseFile: dbFile,
  swapNow: false,
  objectKey: null,
  ...over,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-restoreflow-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  dbFile = path.join(dataDir, 'app.db');
  src = createDatabase(path.join(root, 'src.db'));
  migrateDatabase(src);
  src
    .insert(accounts)
    .values({ name: 'from-backup', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
    .run();
  store = new FakeObjectStore();
  key = parseBackupKey(generateBackupKey()) as Buffer;
  out = [];
  const made = await runBackup(
    { db: src, store, key, prefix: 'backups', tmpDir: path.join(root, 'tmp'), clock: () => NOW },
    'daily',
  );
  objectKey = (made as { objectKey: string }).objectKey;
});
afterEach(() => {
  src.$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('restore script conversation', () => {
  it('lists, asks for a number and the word RESTORE, then stages (the swap waits for the next start)', async () => {
    const t = io(['1', CONFIRM_RESTORE]);
    expect(await restoreFlow(t, opts())).toBe(0);
    expect(out.join('\n')).toContain('Backups, newest first');
    expect(out.join('\n')).toContain('2026-10-08 03:00:00 UTC');
    expect(out.join('\n')).toContain('RESTART the service');
    expect(restoreIsStaged(dataDir)).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(false); // nothing was swapped
  });

  it('anything but exactly RESTORE cancels, and nothing is downloaded or staged', async () => {
    for (const typed of ['restore', 'yes', '', ' RESTOR']) {
      store.calls.length = 0;
      expect(await restoreFlow(io(['1', typed]), opts())).toBe(1);
      expect(restoreIsStaged(dataDir)).toBe(false);
      expect(store.calls).toEqual(['list']);
    }
  });

  it('an empty answer, or a number not in the list, changes nothing', async () => {
    expect(await restoreFlow(io(['']), opts())).toBe(1);
    expect(await restoreFlow(io(['9']), opts())).toBe(1);
    expect(await restoreFlow(io(['0']), opts())).toBe(1);
    expect(await restoreFlow(io(['abc']), opts())).toBe(1);
    expect(restoreIsStaged(dataDir)).toBe(false);
  });

  it('the wrong BACKUP_KEY is reported in words and nothing is staged', async () => {
    const wrong = opts({
      deps: {
        store,
        key: parseBackupKey(generateBackupKey()) as Buffer,
        prefix: 'backups',
        dataDir,
      },
    });
    expect(await restoreFlow(io(['1', CONFIRM_RESTORE]), wrong)).toBe(1);
    expect(out.join('\n')).toContain('BACKUP_KEY is not the key');
    expect(out.join('\n')).toContain('Nothing was changed');
    expect(restoreIsStaged(dataDir)).toBe(false);
  });

  it('a named backup works, an unknown name does not', async () => {
    expect(await restoreFlow(io([CONFIRM_RESTORE]), opts({ objectKey }))).toBe(0);
    expect(
      await restoreFlow(
        io([CONFIRM_RESTORE]),
        opts({ objectKey: 'backups/20200101T000000Z-daily-m7.htbk' }),
      ),
    ).toBe(1);
  });

  it('no backups, or a storage problem, is reported without changes', async () => {
    store.objects.clear();
    expect(await restoreFlow(io([]), opts())).toBe(1);
    expect(out.join('\n')).toContain('no backups');
    out.length = 0;
    store.failNext.set('list', 'network');
    expect(await restoreFlow(io([]), opts())).toBe(1);
    expect(out.join('\n')).toContain('Could not list');
  });

  it('--swap-now needs a second confirmation that the app is stopped', async () => {
    expect(await restoreFlow(io(['1', CONFIRM_RESTORE, 'no']), opts({ swapNow: true }))).toBe(1);
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(restoreIsStaged(dataDir)).toBe(true); // staged, to be applied at the next start
    expect(
      await restoreFlow(io(['1', CONFIRM_RESTORE, CONFIRM_STOPPED]), opts({ swapNow: true })),
    ).toBe(0);
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(restoreIsStaged(dataDir)).toBe(false);
    const db = createDatabase(dbFile);
    expect(
      (db.$client.prepare('SELECT name FROM accounts').all() as { name: string }[])[0]?.name,
    ).toBe('from-backup');
    db.$client.close();
  });

  it('never prints the key or a URL', async () => {
    await restoreFlow(io(['1', CONFIRM_RESTORE]), opts());
    const text = out.join('\n');
    expect(text).not.toContain(key.toString('base64url'));
    expect(text).not.toMatch(/https?:\/\//);
  });
});

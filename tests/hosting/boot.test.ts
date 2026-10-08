import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '@/data/client';
import { runBoot, EXIT_REFUSED, REFUSE_PAUSE_MS, type BootDeps } from '@/hosting/boot';
import { generateBackupKey, parseBackupKey } from '@/hosting/crypto';
import { createLogger } from '@/hosting/logger';
import { runBackup } from '@/hosting/backup';
import { stageRestore } from '@/hosting/restore';
import { startSetupServer, type SetupServer } from '@/hosting/setup-server';
import { realStartupIo, type StartupIo } from '@/hosting/startup';
import type { ChildSpec } from '@/hosting/supervisor';
import { accounts } from '@/data/schema';
import { FakeChild, fakeTime } from '../helpers/fake-child';
import { folderUpTo, removeDir } from '../helpers/migrations';
import { FakeObjectStore } from '../helpers/object-store';

const rnd = (n: number, salt: number) =>
  Array.from(
    { length: n },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'[(i * 7 + salt * 13 + (i % 5) * 3) % 42],
  ).join('');

let root: string;
let dataDir: string;
let dbFile: string;
let env: Record<string, string | undefined>;
let store: FakeObjectStore;
let key: Buffer;
let logs: string[];
let sleeps: number[];
let spawned: { spec: ChildSpec; child: FakeChild }[];
let stopFns: (() => void)[];
let setupStarted: number;
let setupClosed: number;
let onSleep: ((ms: number) => void) | null;
let delivered: number;
let t: ReturnType<typeof fakeTime>;
let mountinfo: string;

function owner(file: string) {
  const d = createDatabase(file);
  d.$client
    .prepare(
      "INSERT OR IGNORE INTO owner (id, password_hash, totp_secret_enc, created_at, updated_at, password_changed_at) VALUES (1, 'h', 'e', 't', 't', 't')",
    )
    .run();
  d.$client.close();
}
function readyDb(withOwner = true) {
  const d = createDatabase(dbFile);
  migrateDatabase(d);
  d.$client.close();
  if (withOwner) owner(dbFile);
}

function deps(over: Partial<BootDeps> = {}): BootDeps {
  const io: StartupIo = {
    ...realStartupIo(),
    readText: (f) => (f === '/proc/self/mountinfo' ? mountinfo : null),
    canWrite: () => true,
  };
  return {
    env,
    io,
    log: createLogger({ write: (l) => logs.push(l), secrets: [] }),
    store,
    key,
    clock: () => new Date('2026-10-08T03:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms);
      onSleep?.(ms);
    },
    startSetupServer: async () => {
      setupStarted += 1;
      const server: SetupServer = { port: () => 0, close: async () => void (setupClosed += 1) };
      return server;
    },
    specs: (port) => [
      {
        name: 'web',
        command: 'node',
        args: ['next', 'start', '-H', '0.0.0.0', '-p', String(port)],
        env: {},
      },
      { name: 'worker', command: 'node', args: ['worker'], env: {} },
    ],
    supervisor: {
      spawn: (spec) => {
        const child = new FakeChild();
        spawned.push({ spec, child });
        return child;
      },
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      write: () => undefined,
    },
    deliver: async () => void (delivered += 1),
    onStopSignal: (stop) => stopFns.push(stop),
    ...over,
  };
}
const stopAll = () => {
  for (const s of stopFns) s();
  for (const s of spawned) s.child.exit(0, 'SIGTERM');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-boot-'));
  dataDir = path.join(root, 'var-data');
  fs.mkdirSync(dataDir);
  dbFile = path.join(dataDir, 'houcine-trades.db');
  key = parseBackupKey(generateBackupKey()) as Buffer;
  env = {
    HOSTED: 'true',
    NODE_ENV: 'production',
    TRADING_MODE: 'paper',
    AUTH_SECRET: rnd(64, 1),
    TRUST_PROXY: 'true',
    DATA_DIR: dataDir,
    DATABASE_URL: `file:${dbFile}`,
    BACKUP_KEY: key.toString('base64url'),
    S3_ENDPOINT: 'https://objects.testhost.dev',
    S3_REGION: 'eu-test-1',
    S3_BUCKET: 'my-backups',
    S3_ACCESS_KEY_ID: `AK${rnd(16, 2)}`,
    S3_SECRET_ACCESS_KEY: rnd(40, 3),
    PORT: '10000',
  };
  mountinfo = `36 35 98:0 / / rw - overlay overlay rw\n40 36 8:1 / ${dataDir} rw - ext4 /dev/sda1 rw\n`;
  store = new FakeObjectStore();
  logs = [];
  sleeps = [];
  spawned = [];
  stopFns = [];
  setupStarted = 0;
  setupClosed = 0;
  onSleep = null;
  delivered = 0;
  t = fakeTime();
});
afterEach(() => removeDir(root));

describe('boot: a good start', () => {
  it('runs the guards, the release step, then starts the web server (on 0.0.0.0 and the platform port) and the worker', async () => {
    readyDb();
    const run = runBoot(deps());
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned.map((s) => s.spec.name)).toEqual(['web', 'worker']);
    expect(spawned[0]?.spec.args).toEqual(['next', 'start', '-H', '0.0.0.0', '-p', '10000']);
    expect(fs.existsSync(path.join(dataDir, '.worker-heartbeat'))).toBe(true);
    expect(store.calls).toEqual([]); // up to date: no backup, no migration
    stopAll();
    expect(await run).toBe(0);
  });

  it('SIGTERM: a clean shutdown with the database checkpointed (one file left)', async () => {
    readyDb();
    const run = runBoot(deps());
    await new Promise((r) => setTimeout(r, 50));
    stopAll();
    expect(await run).toBe(0);
    expect(fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0).toBe(0);
  });
});

describe('boot: every failed guard refuses to start, touches nothing, spawns nothing', () => {
  const cases: [string, () => void][] = [
    ['AUTH_SECRET missing', () => delete env.AUTH_SECRET],
    [
      'AUTH_SECRET placeholder',
      () =>
        (env.AUTH_SECRET = [
          'replace',
          'with',
          'the',
          'output',
          'of',
          'the',
          'generate',
          'command',
          'see',
          'docs',
          'security',
        ].join('-')),
    ],
    ['TRUST_PROXY not configured', () => delete env.TRUST_PROXY],
    ['TRADING_MODE live', () => (env.TRADING_MODE = 'live')],
    ['not production', () => (env.NODE_ENV = 'development')],
    ['BACKUP_KEY missing', () => delete env.BACKUP_KEY],
    ['storage not configured', () => delete env.S3_BUCKET],
    [
      'database outside the disk',
      () => (env.DATABASE_URL = `file:${path.join(root, 'elsewhere.db')}`),
    ],
    ['the disk is not mounted', () => (mountinfo = '36 35 98:0 / / rw - overlay overlay rw\n')],
  ];
  it.each(cases)('%s', async (_n, change) => {
    change();
    const code = await runBoot(deps());
    expect(code).toBe(EXIT_REFUSED);
    expect(spawned).toEqual([]);
    expect(setupStarted).toBe(0);
    expect(store.calls).toEqual([]);
    expect(fs.existsSync(dbFile)).toBe(false); // the database was not even created
    expect(sleeps).toContain(REFUSE_PAUSE_MS); // a pause, so the platform does not loop hot
    expect(logs.join('\n')).toContain('boot.refused');
  });

  it('not hosted at all', async () => {
    env.HOSTED = 'false';
    expect(await runBoot(deps())).toBe(EXIT_REFUSED);
    expect(spawned).toEqual([]);
  });

  it('the refusal log names the problem and never a secret', async () => {
    env.TRUST_PROXY = undefined;
    await runBoot(deps());
    const text = logs.join('\n');
    expect(text).toContain('trust_proxy_unset');
    for (const secret of [
      env.AUTH_SECRET,
      env.BACKUP_KEY,
      env.S3_SECRET_ACCESS_KEY,
      env.S3_ACCESS_KEY_ID,
    ]) {
      expect(text).not.toContain(secret as string);
    }
  });
});

describe('boot: the release step (verified backup, then migrate, then start)', () => {
  it('pending migrations: backup first, then migration, then the app starts', async () => {
    const old = folderUpTo('0005_notifications');
    try {
      const d = createDatabase(dbFile);
      migrateDatabase(d, old);
      d.insert(accounts)
        .values({ name: 'precious', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
        .run();
      d.$client.close();
      owner(dbFile);
      const run = runBoot(deps());
      await new Promise((r) => setTimeout(r, 100));
      expect(store.calls.slice(0, 2)).toEqual(['put', 'get']);
      expect([...store.objects.keys()][0]).toMatch(/pre-migration/);
      expect(spawned.map((s) => s.spec.name)).toEqual(['web', 'worker']);
      const after = createDatabase(dbFile);
      expect(
        (after.$client.prepare('SELECT name FROM accounts').all() as { name: string }[])[0]?.name,
      ).toBe('precious');
      after.$client.close();
      stopAll();
      await run;
    } finally {
      removeDir(old);
    }
  });

  it('the backup fails: the app does NOT start, the old database is untouched, a notice is attempted', async () => {
    const old = folderUpTo('0005_notifications');
    try {
      const d = createDatabase(dbFile);
      migrateDatabase(d, old);
      d.$client.close();
      owner(dbFile);
      store.denyAll = true;
      const code = await runBoot(deps());
      expect(code).toBe(1);
      expect(spawned).toEqual([]);
      expect(delivered).toBe(1);
      const check = createDatabase(dbFile);
      expect(
        check.$client.prepare("SELECT 1 FROM sqlite_master WHERE name = 'backup_runs'").get(),
      ).toBeUndefined(); // still the old schema
      check.$client.close();
      expect(logs.join('\n')).toContain('boot.release_failed');
    } finally {
      removeDir(old);
    }
  });

  it('a database from a NEWER app version: refuse', async () => {
    readyDb();
    const d = createDatabase(dbFile);
    d.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
      )
      .run();
    d.$client.close();
    const code = await runBoot(deps());
    expect(code).toBe(1);
    expect(spawned).toEqual([]);
  });
});

describe('boot: no owner yet means setup mode', () => {
  it('only the health check is up; when the owner appears the app starts', async () => {
    readyDb(false);
    let polls = 0;
    onSleep = (ms) => {
      if (ms === 10_000 && ++polls === 2) owner(dbFile); // the owner is created in the shell
    };
    const run = runBoot(deps());
    await new Promise((r) => setTimeout(r, 100));
    expect(setupStarted).toBe(1);
    expect(setupClosed).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(spawned.map((s) => s.spec.name)).toEqual(['web', 'worker']);
    stopAll();
    expect(await run).toBe(0);
  });

  it('a stop request during setup mode ends cleanly without starting anything', async () => {
    readyDb(false);
    onSleep = () => stopFns.forEach((s) => s());
    const code = await runBoot(deps());
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
    expect(setupClosed).toBeGreaterThanOrEqual(1);
  });

  it('a brand new disk: the release step creates the database, then setup mode', async () => {
    onSleep = () => stopFns.forEach((s) => s());
    const code = await runBoot(deps());
    expect(code).toBe(0);
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(store.calls).toEqual([]); // nothing to protect yet
    expect(setupStarted).toBe(1);
  });
});

describe('boot: a staged restore is applied before anything opens the database', () => {
  it('the restored (older) database is put in place, then migrated after a fresh backup', async () => {
    const old = folderUpTo('0005_notifications');
    try {
      // a backup of an older database
      const src = createDatabase(path.join(root, 'src.db'));
      migrateDatabase(src, old);
      src
        .insert(accounts)
        .values({ name: 'from-backup', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
        .run();
      owner(path.join(root, 'src.db'));
      const made = await runBackup(
        {
          db: src,
          store,
          key,
          prefix: 'backups',
          tmpDir: path.join(root, 'tmp'),
          migrationsFolder: old,
          clock: () => new Date('2026-10-01T03:00:00Z'),
        },
        'daily',
      );
      src.$client.close();
      expect(made.ok).toBe(true);
      // a current database that will be replaced
      readyDb();
      const live = createDatabase(dbFile);
      live
        .insert(accounts)
        .values({ name: 'current', baseCurrency: 'EUR', startingBalance: '1', createdAt: 't' })
        .run();
      live.$client.close();
      const staged = await stageRestore(
        { store, key, prefix: 'backups', dataDir },
        (made as { objectKey: string }).objectKey,
      );
      expect(staged.ok).toBe(true);

      store.calls.length = 0;
      const run = runBoot(deps());
      await new Promise((r) => setTimeout(r, 150));
      const db = createDatabase(dbFile);
      expect(
        (db.$client.prepare('SELECT name FROM accounts').all() as { name: string }[]).map(
          (r) => r.name,
        ),
      ).toEqual(['from-backup']);
      db.$client.close();
      // the restored file was older, so the release step took a pre-migration backup and migrated
      expect(store.calls.slice(0, 2)).toEqual(['put', 'get']);
      expect(fs.readdirSync(dataDir).some((f) => f.includes('.before-restore-'))).toBe(true); // the old one is kept
      expect(fs.existsSync(path.join(dataDir, 'restore', 'READY.json'))).toBe(false);
      expect(spawned.map((s) => s.spec.name)).toEqual(['web', 'worker']);
      stopAll();
      await run;
    } finally {
      removeDir(old);
    }
  });
});

describe('setup server', () => {
  it('answers /healthz and nothing else, on a real loopback socket', async () => {
    const server = await startSetupServer({ port: 0, host: '127.0.0.1' });
    const http = await import('node:http');
    const get = (p: string, method = 'GET') =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: server.port(), path: p, method },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await get('/healthz')).toEqual({ status: 200, body: 'ok' });
    expect(await get('/')).toEqual({ status: 503, body: 'setup not finished' });
    expect(await get('/login')).toEqual({ status: 503, body: 'setup not finished' });
    expect(await get('/healthz', 'POST')).toEqual({ status: 503, body: 'setup not finished' });
    expect(await get('/healthz?x=1')).toEqual({ status: 503, body: 'setup not finished' });
    await server.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBackupKey } from '@/hosting/crypto';
import { createDatabase, migrateDatabase } from '@/data/client';
import {
  checkStartup,
  collectStartupFacts,
  realStartupIo,
  type StartupIo,
} from '@/hosting/startup';

// built at run time: no key-looking literal in the repository
const rnd = (n: number, salt: number) =>
  Array.from(
    { length: n },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'[(i * 7 + salt * 13 + (i % 5) * 3) % 42],
  ).join('');

let root: string;
let dataDir: string;
let env: Record<string, string | undefined>;
let io: StartupIo;
let state: { ownerExists: boolean | null; migrationsPending: number | null };
let mountinfo: string | null;
let writable: boolean;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-startup-'));
  dataDir = path.join(root, 'var-data');
  fs.mkdirSync(dataDir);
  env = {
    HOSTED: 'true',
    NODE_ENV: 'production',
    TRADING_MODE: 'paper',
    AUTH_SECRET: rnd(64, 1),
    TRUST_PROXY: 'true',
    DATA_DIR: dataDir,
    DATABASE_URL: `file:${path.join(dataDir, 'houcine-trades.db')}`,
    BACKUP_KEY: generateBackupKey(),
    S3_ENDPOINT: 'https://objects.testhost.dev',
    S3_REGION: 'eu-test-1',
    S3_BUCKET: 'my-backups',
    S3_ACCESS_KEY_ID: `AK${rnd(16, 2)}`,
    S3_SECRET_ACCESS_KEY: rnd(40, 3),
  };
  state = { ownerExists: true, migrationsPending: 0 };
  mountinfo = `36 35 98:0 / / rw - overlay overlay rw\n40 36 8:1 / ${dataDir} rw,relatime - ext4 /dev/sda1 rw\n`;
  writable = true;
  io = {
    readText: (f) => (f === '/proc/self/mountinfo' ? mountinfo : null),
    canWrite: () => writable,
    databaseState: () => state,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const codes = (stage: 'before_release' | 'after_release' = 'after_release') =>
  checkStartup(env, io, stage).failures.map((f) => f.code);

describe('hosted start-up guards (each refuses to start)', () => {
  it('a complete setup starts', () => {
    expect(checkStartup(env, io, 'after_release')).toEqual({
      ok: true,
      failures: [],
      setupMode: false,
    });
  });

  it.each([
    ['AUTH_SECRET missing', () => delete env.AUTH_SECRET, 'auth_secret'],
    ['AUTH_SECRET too short', () => (env.AUTH_SECRET = 'short'), 'auth_secret'],
    [
      'AUTH_SECRET still the placeholder',
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
      'auth_secret',
    ],
    ['TRUST_PROXY not set', () => delete env.TRUST_PROXY, 'trust_proxy_unset'],
    ['TRUST_PROXY nonsense', () => (env.TRUST_PROXY = 'maybe'), 'trust_proxy_unset'],
    ['TRADING_MODE live', () => (env.TRADING_MODE = 'live'), 'trading_mode'],
    ['NODE_ENV development', () => (env.NODE_ENV = 'development'), 'not_production'],
    ['DATA_DIR missing', () => delete env.DATA_DIR, 'data_dir'],
    ['DATA_DIR relative', () => (env.DATA_DIR = 'data'), 'data_dir'],
    [
      'DATABASE_URL outside the disk',
      () => (env.DATABASE_URL = 'file:/tmp/other.db'),
      'database_outside_data_dir',
    ],
    [
      'DATABASE_URL is the folder itself',
      () => (env.DATABASE_URL = `file:${dataDir}`),
      'database_outside_data_dir',
    ],
    [
      'DATABASE_URL a sibling with the same prefix',
      () => (env.DATABASE_URL = `file:${dataDir}-evil/x.db`),
      'database_outside_data_dir',
    ],
    ['BACKUP_KEY missing', () => delete env.BACKUP_KEY, 'backup_key'],
    ['BACKUP_KEY malformed', () => (env.BACKUP_KEY = 'not-a-key'), 'backup_key'],
    ['BACKUP_KEY same as AUTH_SECRET text', () => (env.BACKUP_KEY = env.AUTH_SECRET), 'backup_key'],
    [
      'BACKUP_KEY is a valid key but also the AUTH_SECRET',
      () => (env.AUTH_SECRET = env.BACKUP_KEY),
      'backup_key',
    ],
    ['S3_BUCKET missing', () => delete env.S3_BUCKET, 'object_store'],
    [
      'S3_ENDPOINT plain http',
      () => (env.S3_ENDPOINT = 'http://objects.testhost.dev'),
      'object_store',
    ],
    [
      'the disk is not mounted',
      () => (mountinfo = '36 35 98:0 / / rw - overlay overlay rw\n'),
      'data_dir_not_mounted',
    ],
    ['the mount table cannot be read', () => (mountinfo = null), 'data_dir_not_mounted'],
    [
      'the disk is mounted read-only',
      () => (mountinfo = `40 36 8:1 / ${dataDir} ro - ext4 /dev/sda1 ro\n`),
      'data_dir_read_only',
    ],
    ['the disk cannot be written', () => (writable = false), 'data_dir_read_only'],
    [
      'migrations pending',
      () => (state = { ownerExists: true, migrationsPending: 2 }),
      'migrations_pending',
    ],
    [
      'migrations unreadable',
      () => (state = { ownerExists: true, migrationsPending: null }),
      'migrations_unreadable',
    ],
    [
      'owner unreadable',
      () => (state = { ownerExists: null, migrationsPending: 0 }),
      'owner_unreadable',
    ],
  ])('%s', (_name, change, code) => {
    change();
    expect(codes()).toContain(code);
  });

  it('before the release step, pending migrations are expected (the release step applies them)', () => {
    state = { ownerExists: true, migrationsPending: 3 };
    expect(codes('before_release')).toEqual([]);
    expect(codes('after_release')).toEqual(['migrations_pending']);
    state = { ownerExists: true, migrationsPending: null };
    expect(codes('before_release')).toEqual([]);
  });

  it('no owner yet is setup mode, not a refusal', () => {
    state = { ownerExists: false, migrationsPending: 0 };
    expect(checkStartup(env, io, 'after_release')).toEqual({
      ok: true,
      failures: [],
      setupMode: true,
    });
  });

  it('not hosted: nothing is checked, so local use is unchanged', () => {
    env = { AUTH_SECRET: 'x' };
    expect(checkStartup(env, io, 'after_release').ok).toBe(true);
  });

  it('messages never contain a value from the environment', () => {
    env.AUTH_SECRET = 'short';
    env.BACKUP_KEY = 'oops-secret-looking-value';
    const text = JSON.stringify(checkStartup(env, io, 'after_release'));
    expect(text).not.toContain('oops-secret-looking-value');
    expect(text).not.toContain(dataDir);
  });
});

describe('start-up facts from the real file system', () => {
  const real = realStartupIo();
  it('a missing database file: no owner, every migration pending', () => {
    const s = real.databaseState(path.join(root, 'missing.db'));
    expect(s.ownerExists).toBe(false);
    expect(s.migrationsPending).toBe(7);
    expect(fs.existsSync(path.join(root, 'missing.db'))).toBe(false); // reading never creates it
  });
  it('a migrated database: owner false until the owner exists', () => {
    const file = path.join(root, 'a.db');
    const db = createDatabase(file);
    migrateDatabase(db);
    expect(real.databaseState(file)).toEqual({ ownerExists: false, migrationsPending: 0 });
    db.$client
      .prepare(
        "INSERT INTO owner (id, password_hash, totp_secret_enc, created_at, updated_at, password_changed_at) VALUES (1, 'h', 'e', 't', 't', 't')",
      )
      .run();
    expect(real.databaseState(file)).toEqual({ ownerExists: true, migrationsPending: 0 });
    db.$client.close();
  });
  it('a damaged file is unreadable, not "fine"', () => {
    const file = path.join(root, 'bad.db');
    fs.writeFileSync(file, 'this is not a database file at all, sorry');
    expect(real.databaseState(file)).toEqual({ ownerExists: null, migrationsPending: null });
  });
  it('a database from a newer app is unreadable for the guard (it must not start)', () => {
    const file = path.join(root, 'new.db');
    const db = createDatabase(file);
    migrateDatabase(db);
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
      )
      .run();
    db.$client.close();
    expect(real.databaseState(file).migrationsPending).toBeNull();
  });
  it('canWrite leaves nothing behind', () => {
    expect(real.canWrite(dataDir)).toBe(true);
    expect(fs.readdirSync(dataDir)).toEqual([]);
    expect(real.canWrite(path.join(root, 'nope'))).toBe(false);
  });
  it('facts are plain: no secret values', () => {
    const facts = collectStartupFacts(env, io);
    expect(JSON.stringify(facts)).not.toContain(env.AUTH_SECRET as string);
    expect(JSON.stringify(facts)).not.toContain(env.BACKUP_KEY as string);
  });
});

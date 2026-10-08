import path from 'node:path';
import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import { createAccount } from '@/data/accounts';
import { appendBackupRun } from '@/data/backups';
import type { Db } from '@/data/client';
import { CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import { unsafeThings } from '../helpers/html';

vi.setConfig({ testTimeout: 60_000 });

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const request = {
  headers: {} as Record<string, string>,
  cookies: {} as Record<string, string>,
  db: undefined as Db | undefined,
};

vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.headers),
  cookies: async () => ({
    get: (name: string) => (name in request.cookies ? { value: request.cookies[name] } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/',
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('@/data/client', async (original) => ({
  ...(await original<typeof import('@/data/client')>()),
  getDb: () => request.db,
}));

let secret = '';
const sameSite = {
  host: 'app.example.test',
  origin: 'https://app.example.test',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'test',
};

async function signIn(cookieName: string) {
  const r = await login(
    request.db as Db,
    { password: PASSWORD, code: codeAt(secret, new Date()) },
    CLIENT,
    { now: new Date() },
  );
  if (!r.ok) throw new Error('sign-in failed');
  request.cookies = { [cookieName]: r.token };
}

beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
  resetAuthEnvCache();
  const owner = await dbWithOwner(getAuthEnv());
  request.db = owner.db;
  secret = owner.secret;
  request.headers = { ...sameSite };
  createAccount(owner.db, { name: 'Paper', baseCurrency: 'USDT', startingBalance: '10000' });
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
  delete process.env.HOSTED;
});

async function render(file: string): Promise<string> {
  const mod = (await import(/* @vite-ignore */ path.join(ROOT, file))) as {
    default: (p: unknown) => Promise<unknown>;
  };
  const element = await mod.default({
    params: Promise.resolve({}),
    searchParams: Promise.resolve({}),
  });
  const { prelude } = await prerender(element as never);
  return (await new Response(prelude).text())
    .replaceAll('<!-- -->', '')
    .replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, '')
    .replaceAll('javascript:throw new Error(&#x27;React form unexpectedly submitted.&#x27;)', '');
}
const page = () => render('src/app/backups/page.tsx');
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const ok = (at: Date) =>
  appendBackupRun(request.db as Db, {
    kind: 'daily',
    outcome: 'ok',
    startedAt: at,
    finishedAt: at,
    objectKey: 'backups/x.htbk',
    sizeBytes: 123456,
    sha256: 'a'.repeat(64),
  });
const failed = (at: Date) =>
  appendBackupRun(request.db as Db, {
    kind: 'daily',
    outcome: 'failed',
    startedAt: at,
    finishedAt: at,
    errorCode: 'store_denied',
  });

describe('on your own computer (not hosted)', () => {
  beforeEach(() => signIn('houcine_session'));

  it('shows the LOCALHOST banner, no hosted banner, no backup warning, and says backups run on the hosted app', async () => {
    const html = await page();
    expect(html).toContain('LOCALHOST ONLY');
    expect(html).not.toContain('HOSTED, PAPER MODE');
    expect(html).not.toContain('Backups:');
    expect(html).toContain('Backups run on the hosted app only');
    expect(html).toContain('PAPER');
    expect(unsafeThings(html)).toEqual([]);
  });
});

describe('hosted', () => {
  beforeEach(async () => {
    process.env.HOSTED = 'true';
    request.headers = { ...sameSite, 'x-forwarded-proto': 'https' };
    await signIn('__Host-houcine_session');
  });

  it('every page shows an unmistakable HOSTED, PAPER MODE banner instead of the localhost one', async () => {
    ok(hoursAgo(1));
    const html = await page();
    expect(html).toContain('HOSTED, PAPER MODE');
    expect(html).toContain('banner-hosted');
    expect(html).not.toContain('LOCALHOST ONLY');
    expect(html).toContain('PAPER');
    expect(unsafeThings(html)).toEqual([]);
  });

  it('a recent verified backup: healthy, no warning in the header', async () => {
    ok(hoursAgo(2));
    const html = await page();
    expect(html).toContain('The latest backup is verified and less than 36 hours old.');
    expect(html).not.toContain('Backups: ');
    expect(html).toContain('123,456 bytes');
    expect(html).toContain('verified');
  });

  it('no verified backup for 36 hours: a warning on the page AND in the header of every page', async () => {
    ok(hoursAgo(40));
    const html = await page();
    expect(html).toContain('No verified backup in the last 36 hours.');
    expect(html).toContain('Backups: none in the last day and a half');
    const dashboard = await render('src/app/page.tsx');
    expect(dashboard).toContain('Backups: none in the last day and a half');
    expect(dashboard).toContain('href="/backups"');
  });

  it('a failed latest attempt is shown with its reason in words (not a code, not an error text)', async () => {
    ok(hoursAgo(20));
    failed(hoursAgo(1));
    const html = await page();
    expect(html).toContain('Backups: last attempt failed');
    expect(html).toContain('failed: the backup storage refused the keys');
    expect(html).not.toContain('store_denied');
  });

  it('never any backup, and one was expected: shown (the owner was created long ago)', async () => {
    (request.db as Db).$client
      .prepare('UPDATE owner SET created_at = ?')
      .run(hoursAgo(100).toISOString());
    const html = await page();
    expect(html).toContain('Backups: none yet');
  });

  it('an unreadable backup state is "status unknown", never hidden', async () => {
    (request.db as Db).$client.exec(
      'DROP TRIGGER backup_runs_no_delete; DROP TRIGGER backup_runs_no_update; DROP TABLE backup_runs;',
    );
    const html = await render('src/app/page.tsx');
    expect(html).toContain('Backups: status unknown');
  });

  it('never shows an object key, a checksum, a key or a URL', async () => {
    ok(hoursAgo(1));
    const html = await page();
    expect(html).not.toContain('backups/x.htbk');
    expect(html).not.toContain('a'.repeat(64));
    expect(html).not.toMatch(/https?:\/\/(?!app\.example\.test)/);
  });
});

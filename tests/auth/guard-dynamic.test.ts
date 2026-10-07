import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import type { Db } from '@/data/client';
import { accounts, riskEvents, setups, trades } from '@/data/schema';
import { codeAt, CLIENT, dbWithOwner, PASSWORD } from '../helpers/auth';
import { PUBLIC_ENTRIES, scanApp } from '../helpers/guard-scan';

// The first import of a page loads its whole module graph, which can take a few seconds.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// A pretend request: tests change these, the mocked Next.js functions read them.
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
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('@/data/client', async (original) => ({
  ...(await original<typeof import('@/data/client')>()),
  getDb: () => request.db,
}));

const sameSite = {
  host: '127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'test-browser',
};

const counts = (db: Db) => ({
  accounts: db.select().from(accounts).all().length,
  setups: db.select().from(setups).all().length,
  trades: db.select().from(trades).all().length,
  riskEvents: db.select().from(riskEvents).all().length,
});

let secret: string;
beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
  process.env.SESSION_IDLE_MINUTES = '120';
  resetAuthEnvCache();
  const owner = await dbWithOwner(getAuthEnv());
  request.db = owner.db;
  secret = owner.secret;
  request.headers = { ...sameSite };
  request.cookies = {};
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
});

const scan = scanApp(ROOT);
const abs = (file: string) => path.join(ROOT, file);
const id = (e: { file: string; exportName: string }) =>
  `${e.file.replaceAll('\\', '/')}#${e.exportName}`;
const guarded = scan.entries.filter((e) => !PUBLIC_ENTRIES.has(id(e)));

async function call(entry: (typeof scan.entries)[number]): Promise<unknown> {
  const mod = (await import(/* @vite-ignore */ abs(entry.file))) as Record<string, unknown>;
  const fn = mod[entry.exportName] as (...args: unknown[]) => Promise<unknown>;
  expect(typeof fn).toBe('function');
  const props = { searchParams: Promise.resolve({}), params: Promise.resolve({ id: '1' }) };
  return entry.kind === 'page'
    ? fn(props)
    : fn({}, { errors: [], values: {} }, new FormData(), new FormData());
}

async function expectRefused(entry: (typeof scan.entries)[number]) {
  const before = counts(request.db as Db);
  await expect(call(entry)).rejects.toMatchObject({ message: 'NEXT_REDIRECT', url: '/login' });
  expect(counts(request.db as Db)).toEqual(before);
}

describe('every discovered entry point refuses a visitor without a session', () => {
  it('discovers the entry points to test', () => {
    expect(guarded.length).toBeGreaterThan(15);
  });

  for (const entry of guarded) {
    it(`${id(entry)}: no cookie`, async () => {
      await expectRefused(entry);
    });
    it(`${id(entry)}: tampered cookie`, async () => {
      request.cookies = { houcine_session: 'A'.repeat(43) };
      await expectRefused(entry);
    });
  }
});

describe('with a real session', () => {
  async function signIn(): Promise<void> {
    const result = await login(
      request.db as Db,
      { password: PASSWORD, code: codeAt(secret, new Date()) },
      CLIENT,
      { now: new Date() },
    );
    if (!result.ok) throw new Error('test sign-in failed');
    request.cookies = { houcine_session: result.token };
  }

  it('a guarded action runs (so the refusals above are the guard, not a broken mock)', async () => {
    await signIn();
    const mod = await import('@/app/setups/actions');
    const form = new FormData();
    form.set('name', 'Breakout');
    await expect(mod.createSetupAction(form)).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      url: expect.stringContaining('/setups?ok='),
    });
    expect(counts(request.db as Db).setups).toBe(1);
  });

  it('a cross-site request is refused even with a valid session', async () => {
    await signIn();
    request.headers = { ...sameSite, origin: 'http://evil.example' };
    const mod = await import('@/app/setups/actions');
    const form = new FormData();
    form.set('name', 'Breakout');
    await expect(mod.createSetupAction(form)).rejects.toThrow('Forbidden');
    expect(counts(request.db as Db).setups).toBe(0);
  });

  it('a request with no Origin header is refused', async () => {
    await signIn();
    const { origin: _omit, ...rest } = request.headers;
    void _omit;
    request.headers = rest;
    const mod = await import('@/app/setups/actions');
    await expect(mod.createSetupAction(new FormData())).rejects.toThrow('Forbidden');
  });

  it('fails closed when AUTH_SECRET is missing', async () => {
    await signIn();
    delete process.env.AUTH_SECRET;
    resetAuthEnvCache();
    const mod = await import('@/app/setups/actions');
    await expect(mod.createSetupAction(new FormData())).rejects.toMatchObject({ url: '/login' });
  });
});

describe('sensitive actions ask for a fresh code (action layer)', () => {
  async function signInNotFresh(): Promise<void> {
    const result = await login(
      request.db as Db,
      { password: PASSWORD, code: codeAt(secret, new Date()) },
      CLIENT,
      { now: new Date() },
    );
    if (!result.ok) throw new Error('test sign-in failed');
    request.cookies = { houcine_session: result.token };
    // Signing in counts as a fresh code; forget that so the actions must ask again.
    (request.db as Db).$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
  }
  const nextCode = () => codeAt(secret, new Date(Date.now() + 30_000)); // the step after the sign-in's
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const redirectUrl = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      return (e as { url?: string }).url ?? '';
    }
    return '';
  };
  const DEFAULTS = {
    accountId: '1',
    maxRiskPerTradePercent: '1',
    maxDailyLossPercent: '3',
    maxOpenRiskPercent: '3',
    maxOpenTrades: '3',
    maxDrawdownPercent: '10',
    minRewardToRisk: '1.5',
  };
  const RESET = {
    accountId: '1',
    haltKind: 'manual',
    confirm: 'RESET',
    reason: 'rested and reviewed',
  };

  beforeEach(async () => {
    const { createAccount } = await import('@/data/accounts');
    createAccount(request.db as Db, {
      name: 'Paper',
      baseCurrency: 'USDT',
      startingBalance: '10000',
    });
  });

  it('the kill switch needs no code, a reset does', async () => {
    await signInNotFresh();
    const risk = await import('@/app/risk/actions');
    const halt = await redirectUrl(risk.haltAction(form({ accountId: '1', reason: 'unwell' })));
    expect(decodeURIComponent(halt)).toContain('Trading is halted');

    const refused = decodeURIComponent(await redirectUrl(risk.resetAction(form(RESET))));
    expect(refused).toContain('fresh authenticator code');
    const db = request.db as Db;
    expect(
      (
        db.$client.prepare(`SELECT count(*) c FROM risk_events WHERE kind = 'reset'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it('a wrong typed code is refused; a right one works and is then fresh for 5 minutes', async () => {
    await signInNotFresh();
    const risk = await import('@/app/risk/actions');
    await redirectUrl(risk.haltAction(form({ accountId: '1', reason: 'unwell' })));

    const wrong = decodeURIComponent(
      await redirectUrl(risk.resetAction(form({ ...RESET, stepUpCode: '000000' }))),
    );
    expect(wrong).toContain('not accepted');

    const good = decodeURIComponent(
      await redirectUrl(risk.resetAction(form({ ...RESET, stepUpCode: nextCode() }))),
    );
    expect(good).toContain('halt was reset');

    // Fresh now: another sensitive action needs no new code.
    await redirectUrl(risk.haltAction(form({ accountId: '1', reason: 'again' })));
    const again = decodeURIComponent(await redirectUrl(risk.resetAction(form(RESET))));
    expect(again).toContain('halt was reset');
  });

  it('loosening a limit needs a code, tightening does not', async () => {
    await signInNotFresh();
    const risk = await import('@/app/risk/actions');
    const tighter = decodeURIComponent(
      await redirectUrl(
        risk.updateSettingsAction(form({ ...DEFAULTS, maxRiskPerTradePercent: '0.5' })),
      ),
    );
    expect(tighter).toContain('Applied now');
    const looser = decodeURIComponent(
      await redirectUrl(
        risk.updateSettingsAction(form({ ...DEFAULTS, maxRiskPerTradePercent: '1' })),
      ),
    );
    expect(looser).toContain('fresh authenticator code');
  });

  it('the typed code is not echoed back to the page', async () => {
    const { formValues } = await import('@/app/_lib/form');
    expect(formValues(form({ stepUpCode: '123456', name: 'x' }))).toEqual({ name: 'x' });
  });
});

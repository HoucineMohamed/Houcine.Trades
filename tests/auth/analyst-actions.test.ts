import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import { createAccount } from '@/data/accounts';
import { getAiSettings } from '@/data/analyst';
import type { Db } from '@/data/client';
import { listAuthEvents } from '@/data/auth';
import { CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import {
  fakeClient,
  okReply,
  planJson,
  readyRuntime,
  tutorJson,
  type FakeClient,
} from '../helpers/analyst';

vi.setConfig({ testTimeout: 30_000 });

const request = {
  headers: {} as Record<string, string>,
  cookies: {} as Record<string, string>,
  db: undefined as Db | undefined,
};
const analystRuntime = {
  current: undefined as ReturnType<typeof readyRuntime> | undefined,
  client: undefined as FakeClient | undefined,
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
// The real runtime would build a network client from the key; tests always use the fake one.
vi.mock('@/analyst/runtime', () => ({
  getAnalystRuntime: () =>
    analystRuntime.current ?? { status: 'unavailable', message: 'No API key is set.' },
  getAnalystAvailability: () => ({ keyReady: true, model: 'claude-sonnet-5-5', message: null }),
}));

const sameSite = {
  host: '127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'test-browser',
};

let secret = '';
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
  const r = await login(
    owner.db,
    { password: PASSWORD, code: codeAt(secret, new Date()) },
    CLIENT,
    {
      now: new Date(),
    },
  );
  if (!r.ok) throw new Error('sign-in failed');
  request.cookies = { houcine_session: r.token };
  // Signing in counts as a fresh code; forget that so the actions must ask again.
  owner.db.$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
  analystRuntime.client = fakeClient(okReply(tutorJson()));
  analystRuntime.current = readyRuntime(analystRuntime.client);
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectUrl = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return decodeURIComponent((e as { url?: string }).url ?? '');
  }
  return '';
};
const nextCode = () => codeAt(secret, new Date(Date.now() + 30_000));
const db = () => request.db as Db;
const kinds = () => listAuthEvents(db()).map((e) => e.kind);

describe('the privacy switch (action layer)', () => {
  it('is OFF by default', () => {
    expect(getAiSettings(db()).consent).toBe(false);
  });

  it('turning ON needs the confirmation box AND a fresh code', async () => {
    const a = await import('@/app/analyst/actions');
    expect(
      await redirectUrl(a.setConsentAction(form({ consent: 'on', stepUpCode: nextCode() }))),
    ).toContain('Tick the box');
    expect(
      await redirectUrl(a.setConsentAction(form({ consent: 'on', understood: 'yes' }))),
    ).toContain('fresh authenticator code');
    expect(
      await redirectUrl(
        a.setConsentAction(form({ consent: 'on', understood: 'yes', stepUpCode: '000000' })),
      ),
    ).toContain('not accepted');
    expect(getAiSettings(db()).consent).toBe(false);
    expect(kinds()).not.toContain('ai_consent_on');
  });

  it('turning ON with the box and a right code works, is logged, and OFF then needs nothing', async () => {
    const a = await import('@/app/analyst/actions');
    const on = await redirectUrl(
      a.setConsentAction(form({ consent: 'on', understood: 'yes', stepUpCode: nextCode() })),
    );
    expect(on).toContain('switch is ON');
    expect(getAiSettings(db()).consent).toBe(true);
    db().$client.prepare('UPDATE sessions SET step_up_at = NULL').run(); // not fresh any more
    const off = await redirectUrl(a.setConsentAction(form({ consent: 'off' })));
    expect(off).toContain('switch is OFF');
    expect(getAiSettings(db()).consent).toBe(false);
    expect(kinds()).toEqual(expect.arrayContaining(['ai_consent_on', 'ai_consent_off']));
  });
});

describe('caps (action layer)', () => {
  const caps = (over: Record<string, string> = {}) =>
    form({ dailyCalls: '20', monthlyCalls: '200', monthlyCostUsd: '5', ...over });

  it('tightening needs no code; loosening does, and above a ceiling is refused', async () => {
    const a = await import('@/app/analyst/actions');
    expect(await redirectUrl(a.updateCapsAction(caps({ dailyCalls: '5' })))).toContain(
      'Applied now',
    );
    expect(await redirectUrl(a.updateCapsAction(caps({ dailyCalls: '50' })))).toContain(
      'fresh authenticator code',
    );
    expect(
      await redirectUrl(a.updateCapsAction(caps({ dailyCalls: '50', stepUpCode: nextCode() }))),
    ).toContain('Waiting 24 hours');
    expect(getAiSettings(db()).effective?.dailyCalls).toBe(5);
    expect(await redirectUrl(a.updateCapsAction(caps({ monthlyCostUsd: '26' })))).toContain(
      'hard ceiling',
    );
  });
});

describe('asking (action layer, with the fake client)', () => {
  async function switchOn() {
    const a = await import('@/app/analyst/actions');
    await redirectUrl(
      a.setConsentAction(form({ consent: 'on', understood: 'yes', stepUpCode: nextCode() })),
    );
    return a;
  }

  it('the tutor refuses while the switch is off and sends nothing', async () => {
    const a = await import('@/app/analyst/actions');
    const url = await redirectUrl(a.runTutorAction(form({ question: 'What is risk?' })));
    expect(url).toContain('/analyst/tutor?error=');
    expect(url).toContain('privacy switch');
    expect(analystRuntime.client?.requests).toHaveLength(0);
  });

  it('the tutor answers once the switch is on and redirects to the stored answer', async () => {
    const a = await switchOn();
    const url = await redirectUrl(
      a.runTutorAction(form({ question: 'What is risk?', accountId: '1' })),
    );
    expect(url).toMatch(/^\/analyst\/reviews\/1$/);
    expect(analystRuntime.client?.requests).toHaveLength(1);
    const again = await redirectUrl(
      a.runTutorAction(form({ question: 'What is risk?', accountId: '1' })),
    );
    expect(again).toBe('/analyst/reviews/1?stored=1');
    expect(analystRuntime.client?.requests).toHaveLength(1);
  });

  it('an empty tutor question is refused without asking', async () => {
    const a = await switchOn();
    expect(await redirectUrl(a.runTutorAction(form({ question: '   ' })))).toContain(
      'Type a question',
    );
  });

  it('the weekly review explains an empty range in plain words', async () => {
    const a = await switchOn();
    const url = await redirectUrl(
      a.runWeeklyAction(
        form({ accountId: '1', from: '2026-03-02', to: '2026-03-08', currency: 'USDT' }),
      ),
    );
    expect(url).toContain('/analyst/review?error=');
    expect(url).toContain('no closed trades');
    expect(analystRuntime.client?.requests).toHaveLength(0);
  });

  it('plan review: the verdict comes from the server engine, not from the browser', async () => {
    const a = await switchOn();
    analystRuntime.client = fakeClient(okReply(planJson()));
    analystRuntime.current = readyRuntime(analystRuntime.client);
    const values = {
      accountId: '1',
      symbol: 'btcusdt',
      direction: 'long',
      status: 'planned',
      plannedEntry: '100',
      stopLoss: '95',
      size: '1000', // far too big: the engine refuses
      quoteCurrency: 'usdt',
      planNotes: 'x',
      emotion: 'calm',
      // a forged verdict from the browser is simply not a thing the action reads
      verdict: 'APPROVED',
    };
    const r = await a.askPlanReviewAction(values);
    expect(r.ok).toBe(true);
    const sent = analystRuntime.client.requests[0]?.user ?? '';
    expect(sent).toMatch(/^verdict: REFUSED/m);
    expect(sent).not.toMatch(/^verdict: APPROVED/m);
    expect(sent).not.toContain('forged');
  });

  it('plan review with the switch off answers with a plain message', async () => {
    const a = await import('@/app/analyst/actions');
    const r = await a.askPlanReviewAction({
      accountId: '1',
      symbol: 'BTCUSDT',
      direction: 'long',
      plannedEntry: '100',
      stopLoss: '95',
      size: '1',
      quoteCurrency: 'USDT',
    });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain('privacy switch');
  });
});

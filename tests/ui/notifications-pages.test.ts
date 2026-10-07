import path from 'node:path';
import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import { createAccount } from '@/data/accounts';
import type { Db } from '@/data/client';
import { insertEvents, recordAttempt } from '@/data/notifications';
import { makeEvent } from '@/domain/notifications';
import { CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import { unsafeThings } from '../helpers/html';
import { enableAlerts, fakeBotToken, fakeChatId } from '../helpers/notifications';

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

const sameSite = {
  host: '127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'test-browser',
};

let token = '';
let chat = '';
beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
  token = fakeBotToken();
  chat = fakeChatId();
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_CHAT_ID = chat;
  resetAuthEnvCache();
  const owner = await dbWithOwner(getAuthEnv());
  request.db = owner.db;
  request.headers = { ...sameSite };
  createAccount(owner.db, { name: 'Paper', baseCurrency: 'USDT', startingBalance: '10000' });
  const r = await login(
    owner.db,
    { password: PASSWORD, code: codeAt(owner.secret, new Date()) },
    CLIENT,
    { now: new Date() },
  );
  if (!r.ok) throw new Error('sign-in failed');
  request.cookies = { houcine_session: r.token };
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
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
    .replaceAll('javascript:throw new Error(&#x27;React form unexpectedly submitted.&#x27;)', '')
    .replaceAll("javascript:throw new Error('React form unexpectedly submitted.')", '');
}
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const ADVICE = /\b(good|bad|great|poor|best|worst|should|ought|recommend\w*|be honest|you must)\b/i;
const PAGE = 'src/app/notifications/page.tsx';

describe('the Alerts page', () => {
  it('renders without inline style, script or external URL, and never contains the token or the chat id', async () => {
    const html = await render(PAGE);
    expect(html.length).toBeGreaterThan(500);
    expect(unsafeThings(html)).toEqual([]);
    expect(html).not.toContain(token);
    expect(html).not.toContain(token.split(':')[1] as string);
    expect(html).not.toContain(chat);
  });
  it('the switch is OFF by default and the consent screen lists what is sent, what is never sent, and the encryption fact', async () => {
    const text = textOf(await render(PAGE));
    expect(text).toMatch(/Send alerts to Telegram.*OFF/);
    expect(text).toContain('What is sent');
    expect(text).toContain('What is never sent');
    for (const w of [
      'notes',
      'emotions',
      'setup names',
      'symbols',
      'account names',
      'balances',
      'amounts',
      'prices',
      'API keys',
      'tokens',
      'passwords',
      'emails',
      'IP addresses',
    ]) {
      expect(text, w).toContain(w);
    }
    expect(text).toMatch(/pass through Telegram.{1,8}s servers/);
    expect(text).toMatch(/not end-to-end encrypted/);
    expect(text).toMatch(/Only events from the moment you switch on/);
  });
  it('says "not set up" and disables Turn ON when there is no token', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const html = await render(PAGE);
    expect(textOf(html)).toContain('not set up');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Turn ON/);
    expect(unsafeThings(html)).toEqual([]);
  });
  it('uses no advice or judging wording', async () => {
    expect(textOf(await render(PAGE))).not.toMatch(ADVICE);
  });
  it('shows the ceilings and the retry rule', async () => {
    const text = textOf(await render(PAGE));
    expect(text).toContain('At most 20 messages an hour, plus 10 more');
    expect(text).toContain('1, 2, 4, 8 and 16 minutes');
  });
  it('lists events as their fixed sentence with a plain delivery word, and never anything typed by the user', async () => {
    const db = request.db as Db;
    const now = new Date();
    enableAlerts(db, new Date(now.getTime() - 1000));
    insertEvents(
      db,
      [
        makeEvent({
          kind: 'daily_loss_usage',
          dedupeKey: 'a',
          occurredAt: now.toISOString(),
          accountId: 1,
          level: 80,
        }),
        makeEvent({ kind: 'login_success', dedupeKey: 'b', occurredAt: now.toISOString() }),
      ],
      now,
    );
    recordAttempt(db, {
      eventId: 1,
      channel: 'telegram',
      status: 'failed',
      at: now,
      errorCode: 'forbidden',
    });
    const text = textOf(await render(PAGE));
    expect(text).toContain('Daily loss limit: 80 % of the limit is used (account #1).');
    expect(text).toContain('failed, will retry');
    expect(text).toContain('last error: forbidden');
    expect(text).toContain('waiting to be sent');
  });
  it('the header shows "not getting through" only when alerts are ON and failing', async () => {
    const db = request.db as Db;
    const now = new Date();
    expect(textOf(await render(PAGE))).not.toContain('not getting through');
    enableAlerts(db, new Date(now.getTime() - 3_600_000));
    insertEvents(
      db,
      [
        makeEvent({
          kind: 'login_success',
          dedupeKey: 'x',
          occurredAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        }),
      ],
      now,
    );
    for (let i = 0; i < 3; i++)
      recordAttempt(db, {
        eventId: 1,
        channel: 'telegram',
        status: 'failed',
        at: new Date(now.getTime() - 60_000 * (3 - i)),
        errorCode: 'network',
      });
    const html = await render(PAGE);
    expect(textOf(html)).toContain('Alerts: not getting through');
    expect(unsafeThings(html)).toEqual([]);
    expect(html).not.toContain(token);
  });
});

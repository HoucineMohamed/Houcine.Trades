import path from 'node:path';
import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import { runAnalyst } from '@/analyst/service';
import { setAiConsent } from '@/data/analyst';
import type { Db } from '@/data/client';
import { buildTutorPrompt } from '@/domain/analyst';
import { CLIENT, codeAt, dbWithOwner, freshAuthForTests, PASSWORD } from '../helpers/auth';
import { fakeApiKey, fakeClient, okReply, readyRuntime, tutorJson } from '../helpers/analyst';
import { unsafeThings } from '../helpers/html';
import { riskDb } from '../helpers/risk';
import { createAccount } from '@/data/accounts';

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

let secret = '';
let key = '';
beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
  key = fakeApiKey();
  process.env.ANTHROPIC_API_KEY = key;
  resetAuthEnvCache();
  const owner = await dbWithOwner(getAuthEnv());
  request.db = owner.db;
  secret = owner.secret;
  request.headers = { ...sameSite };
  request.cookies = {};
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
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
  delete process.env.ANTHROPIC_API_KEY;
});

async function render(
  file: string,
  props: { params?: object; search?: object } = {},
): Promise<string> {
  const mod = (await import(/* @vite-ignore */ path.join(ROOT, file))) as {
    default: (p: unknown) => Promise<unknown>;
  };
  const element = await mod.default({
    params: Promise.resolve(props.params ?? {}),
    searchParams: Promise.resolve(props.search ?? {}),
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

const PAGES = [
  'src/app/analyst/page.tsx',
  'src/app/analyst/review/page.tsx',
  'src/app/analyst/tutor/page.tsx',
];

describe('analyst pages', () => {
  it('render without inline style, script or external URL, and never contain the API key', async () => {
    for (const file of PAGES) {
      const html = await render(file);
      expect(html.length, file).toBeGreaterThan(500);
      expect(unsafeThings(html), file).toEqual([]);
      expect(html, file).not.toContain(key);
    }
  });

  it('the settings page shows the usage as an ESTIMATE and names the console limit as the real hard stop', async () => {
    const text = textOf(await render('src/app/analyst/page.tsx'));
    expect(text).toContain('ESTIMATE');
    expect(text).toContain('spend limit you set in the Anthropic console is the real hard stop');
    expect(text).toMatch(/last verified \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/Calls today \(UTC\) 0 of 20/);
    expect(text).toMatch(/Estimated cost this month.*0 of 5 USD/);
  });

  it('the privacy switch is OFF by default and the consent screen lists what is and is not sent', async () => {
    const text = textOf(await render('src/app/analyst/page.tsx'));
    expect(text).toMatch(/Privacy switch .*Send journal data to the AI.*OFF/);
    expect(text).toContain('What is sent');
    expect(text).toMatch(/trade plan or the closed trades/);
    expect(text).toMatch(/your notes, emotions and setup names/);
    expect(text).toMatch(/the questions you type/);
    expect(text).toContain('What is never sent');
    expect(text).toMatch(/API keys, your password, authenticator codes or secrets/);
    expect(text).toMatch(/account names or numbers/);
  });

  it('shows "not usable" with a plain reason when there is no key, and still renders', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const html = await render('src/app/analyst/page.tsx');
    expect(textOf(html)).toContain('No API key is set');
    expect(unsafeThings(html)).toEqual([]);
  });

  it('uses no advice or judging wording', async () => {
    for (const file of PAGES) expect(textOf(await render(file)), file).not.toMatch(ADVICE);
  });

  it('turning the switch ON is shown as ON afterwards, with the OFF button', async () => {
    setAiConsent(request.db as Db, true, freshAuthForTests(1, new Date()), new Date());
    const text = textOf(await render('src/app/analyst/page.tsx'));
    expect(text).toMatch(/Send journal data to the AI.*ON/);
    expect(text).toContain('Turn OFF');
  });
});

describe('a stored answer is shown as escaped plain text', () => {
  async function storeHostile(): Promise<number> {
    const db = request.db as Db;
    setAiConsent(db, true, freshAuthForTests(1, new Date()), new Date());
    const hostile = tutorJson({
      explanation:
        '<img src=x onerror=alert(1)> <script>alert(2)</script> [click](http://evil.example/x) ![i](http://evil.example/i.png) **bold** You should close the trade.',
      key_points: ['<b>bold</b>'],
      cited_figures: [{ label: 'made up', value: '123456' }],
    });
    const r = await runAnalyst(
      db,
      readyRuntime(fakeClient(okReply(hostile))),
      buildTutorPrompt({ question: 'What is risk?', currency: null, metrics: [] }),
      { accountId: null, subject: 'What is risk?' },
      new Date(),
    );
    if (!r.ok) throw new Error(r.message);
    return r.reviewId;
  }

  it('escapes HTML, never makes links or images, flags the figure and the wording, and carries the label', async () => {
    const id = await storeHostile();
    const html = await render('src/app/analyst/reviews/[id]/page.tsx', {
      params: { id: String(id) },
    });
    // Only REAL tags are inspected: the hostile words appear as escaped text, which is inert.
    const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];
    expect(
      tags.filter((t) => /\son[a-z]+\s*=|\sstyle\s*=|(href|src|action)="https?:/i.test(t)),
    ).toEqual([]);
    expect(
      tags.filter(
        (t) =>
          /^<(img|script|style|iframe|object|embed|link|svg-?\w*)\b/i.test(t) &&
          !/^<svg\b/i.test(t),
      ),
    ).toEqual([]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toMatch(/<a [^>]*evil\.example/);
    expect(html).toContain('[click](http://evil.example/x)'); // shown as TEXT
    expect(html).not.toContain(key);
    const text = textOf(html);
    expect(text).toContain('AI commentary, not advice; the risk engine decides');
    expect(text).toContain('unverified');
    expect(text).toContain('Wording check');
    expect(text).toContain('You should close the trade.'); // the text is kept
  });

  it('lists the stored answer in the history and shows the usage in the log table', async () => {
    const id = await storeHostile();
    const html = await render('src/app/analyst/page.tsx');
    const text = textOf(html);
    expect(html).toContain(`/analyst/reviews/${id}`);
    expect(text).toContain('Read again');
    expect(text).toMatch(/Tutor .* ok/);
    expect(html).not.toContain(key);
  });

  it('an unknown review id is a not-found, not a crash', async () => {
    await expect(
      render('src/app/analyst/reviews/[id]/page.tsx', { params: { id: '999' } }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(
      render('src/app/analyst/reviews/[id]/page.tsx', { params: { id: 'abc' } }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

void riskDb;

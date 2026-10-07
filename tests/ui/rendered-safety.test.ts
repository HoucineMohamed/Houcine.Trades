import fs from 'node:fs';
import path from 'node:path';
import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import type { Db } from '@/data/client';
import { createAccount } from '@/data/accounts';
import { haltManually } from '@/data/risk';
import { closeTrade, createTrade } from '@/data/trades';
import { seedDemo } from '../../scripts/dev/seed-demo';
import { CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import { unsafeThings } from '../helpers/html';

// The first import of a page loads its whole module graph, which can take a few seconds.
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
beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
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

async function signIn(): Promise<void> {
  const r = await login(
    request.db as Db,
    { password: PASSWORD, code: codeAt(secret, new Date()) },
    CLIENT,
    { now: new Date() },
  );
  if (!r.ok) throw new Error('test sign-in failed');
  request.cookies = { houcine_session: r.token };
}

type Page = (props: unknown) => Promise<unknown>;
const PAGES: {
  route: string;
  file: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}[] = [
  { route: '/', file: 'src/app/page.tsx' },
  { route: '/trades', file: 'src/app/trades/page.tsx' },
  {
    route: '/trades?status=closed&sort=pnl',
    file: 'src/app/trades/page.tsx',
    search: { status: 'closed', sort: 'pnl' },
  },
  { route: '/trades/new', file: 'src/app/trades/new/page.tsx' },
  { route: '/trades/[id] closed', file: 'src/app/trades/[id]/page.tsx', params: { id: '1' } },
  { route: '/trades/[id] override', file: 'src/app/trades/[id]/page.tsx', params: { id: '39' } },
  { route: '/trades/[id] open', file: 'src/app/trades/[id]/page.tsx', params: { id: '40' } },
  { route: '/trades/[id] planned', file: 'src/app/trades/[id]/page.tsx', params: { id: '42' } },
  { route: '/trades/[id]/edit', file: 'src/app/trades/[id]/edit/page.tsx', params: { id: '1' } },
  { route: '/stats', file: 'src/app/stats/page.tsx' },
  { route: '/risk', file: 'src/app/risk/page.tsx', search: { entry: '100', stop: '95' } },
  { route: '/analyst', file: 'src/app/analyst/page.tsx' },
  { route: '/analyst/review', file: 'src/app/analyst/review/page.tsx' },
  { route: '/analyst/tutor', file: 'src/app/analyst/tutor/page.tsx' },
  { route: '/accounts', file: 'src/app/accounts/page.tsx' },
  { route: '/setups', file: 'src/app/setups/page.tsx' },
  { route: '/security', file: 'src/app/security/page.tsx' },
  { route: '/step-up', file: 'src/app/step-up/page.tsx', search: { e: 'invalid', next: '/risk' } },
];

async function render(entry: (typeof PAGES)[number]): Promise<string> {
  const mod = (await import(/* @vite-ignore */ path.join(ROOT, entry.file))) as { default: Page };
  const element = await mod.default({
    params: Promise.resolve(entry.params ?? {}),
    searchParams: Promise.resolve(entry.search ?? {}),
  });
  // prerender (not renderToStaticMarkup) because the pages contain async server components
  const { prelude } = await prerender(element as never);
  const raw = await new Response(prelude).text();
  // React's own stand-in for forms with function actions when rendered OUTSIDE Next.js (Next
  // replaces it with a real action). It is a script and a javascript: address that our pages
  // never contain themselves, so only these exact strings are removed before the check.
  return raw
    .replaceAll('<!-- -->', '') // React's separators between adjacent text pieces
    .replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, '')
    .replaceAll('javascript:throw new Error(&#x27;React form unexpectedly submitted.&#x27;)', '')
    .replaceAll("javascript:throw new Error('React form unexpectedly submitted.')", '');
}

describe('rendered pages carry no inline style, script or external URL (demo data)', () => {
  beforeEach(async () => {
    seedDemo(request.db as Db, new Date());
    await signIn();
  });
  for (const entry of PAGES) {
    it(`${entry.route}`, async () => {
      const html = await render(entry);
      expect(html.length).toBeGreaterThan(500);
      expect(unsafeThings(html)).toEqual([]);
    });
  }
  it('the page shows PAPER and the halt status in the header', async () => {
    const html = await render(PAGES[0] as (typeof PAGES)[number]);
    expect(html).toContain('PAPER');
    expect(html).toMatch(/No halt active|HALTED/);
    expect(html).toContain('LOCALHOST ONLY');
  });
});

describe('rendered pages with an empty database', () => {
  beforeEach(async () => {
    await signIn();
  });
  for (const entry of PAGES.filter((p) => !p.params)) {
    it(`${entry.route} (no account)`, async () => {
      const html = await render(entry);
      expect(unsafeThings(html)).toEqual([]);
    });
  }
  it('the dashboard guides a new user through three steps', async () => {
    const html = await render(PAGES[0] as (typeof PAGES)[number]);
    expect(html).toContain('Create a paper account');
    expect(html).toContain('Review the risk limits');
    expect(html).toContain('Log a first paper trade');
  });
  it('an account with no trades shows the empty states, not errors', async () => {
    createAccount(request.db as Db, {
      name: 'Empty',
      baseCurrency: 'USDT',
      startingBalance: '1000',
    });
    for (const entry of PAGES.filter((p) => !p.params)) {
      const html = await render(entry);
      expect(unsafeThings(html), entry.route).toEqual([]);
    }
  });
});

describe('a halted account and odd data still render safely', () => {
  it('shows the halt on the dashboard, a file path stays text and notes are escaped', async () => {
    const db = request.db as Db;
    const account = createAccount(db, {
      name: 'Odd',
      baseCurrency: 'USDT',
      startingBalance: '10000',
    });
    const t = createTrade(
      db,
      {
        accountId: account.id,
        symbol: 'BTCUSDT',
        assetClass: 'crypto',
        direction: 'long',
        status: 'open',
        plannedEntry: '100000',
        entryPrice: '100000',
        stopLoss: '90000',
        size: '1',
        quoteCurrency: 'USDT',
        openedAt: '2026-01-01T00:00:00Z',
        screenshotPath: 'C:\\screens\\a.png',
        planNotes: '<script>alert(1)</script>',
      },
      { now: () => new Date('2026-01-01T00:00:00Z') },
    );
    closeTrade(
      db,
      t.id,
      { exitPrice: '99500', closedAt: new Date().toISOString() }, // a 500 loss today: 5 % of 10000
      { now: () => new Date() },
    );
    await signIn();
    const dash = await render(PAGES[0] as (typeof PAGES)[number]);
    expect(dash).toContain('HALTED');
    expect(unsafeThings(dash)).toEqual([]);
    const detail = await render({
      route: 'detail',
      file: 'src/app/trades/[id]/page.tsx',
      params: { id: String(t.id) },
    });
    expect(unsafeThings(detail)).toEqual([]);
    expect(detail).not.toContain('href="C:');
    expect(detail).toContain('C:\\screens\\a.png'); // a file path stays plain text
    expect(detail).toContain('&lt;script&gt;'); // notes are escaped text
  });
});

describe('page structure', () => {
  it('journal: every table row has as many cells as the table has column headers', async () => {
    seedDemo(request.db as Db, new Date());
    await signIn();
    const html = await render(PAGES[1] as (typeof PAGES)[number]);
    const table = /<table[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    const headers = (/<thead>[\s\S]*?<\/thead>/.exec(table)?.[0].match(/<th[\s>]/g) ?? []).length;
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(1);
    expect(headers).toBeGreaterThan(5);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect((r[1]?.match(/<t[dh][\s>]/g) ?? []).length).toBe(headers);
  });

  it('the header shows a halt on ANOTHER account, not only on the selected one', async () => {
    const db = request.db as Db;
    const a = createAccount(db, { name: 'Alpha', baseCurrency: 'USDT', startingBalance: '1000' });
    const b = createAccount(db, { name: 'Bravo', baseCurrency: 'USDT', startingBalance: '1000' });
    haltManually(db, b.id, 'testing the header');
    await signIn();
    request.cookies = { ...request.cookies, houcine_account: String(a.id) };
    const html = await render(PAGES[0] as (typeof PAGES)[number]);
    expect(html).toContain('No halt active'); // Alpha, the selected one
    expect(html).toMatch(/Bravo: HALTED: manual halt/);
  });

  it('every help summary names its topic for screen readers', async () => {
    seedDemo(request.db as Db, new Date());
    await signIn();
    const html = await render(PAGES[9] as (typeof PAGES)[number]); // /stats
    expect(html).toContain('visually-hidden');
    expect(html).toMatch(
      /What does this mean\?<span class="visually-hidden"> about: [^<]+<\/span>/,
    );
  });
});

describe('a screenshot link', () => {
  it('is a plain outbound link for http(s) only, and the only thing the detector flags', async () => {
    const db = request.db as Db;
    const account = createAccount(db, {
      name: 'Link',
      baseCurrency: 'USDT',
      startingBalance: '10000',
    });
    const t = createTrade(
      db,
      {
        accountId: account.id,
        symbol: 'BTCUSDT',
        assetClass: 'crypto',
        direction: 'long',
        status: 'planned',
        plannedEntry: '100',
        stopLoss: '95',
        size: '1',
        quoteCurrency: 'USDT',
        screenshotPath: 'https://example.com/shot.png',
      },
      { now: () => new Date() },
    );
    await signIn();
    const html = await render({
      route: 'link',
      file: 'src/app/trades/[id]/page.tsx',
      params: { id: String(t.id) },
    });
    expect(html).toContain('href="https://example.com/shot.png"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/<img[\s>]/);
    expect(unsafeThings(html)).toEqual(['an external URL in href: https://example.com/shot.png']);
  });
});

describe('the stylesheets', () => {
  const dir = path.join(ROOT, 'src', 'app');
  const css: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.css')) css.push(p);
    }
  };
  walk(dir);

  it('are found', () => {
    expect(css.map((p) => path.basename(p)).sort()).toEqual([
      'base.css',
      'components.css',
      'tokens.css',
    ]);
  });
  it('load nothing from anywhere: no url(), no @import, no @font-face', () => {
    for (const file of css) {
      const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(text, file).not.toMatch(/url\s*\(/i);
      expect(text, file).not.toMatch(/@import/i);
      expect(text, file).not.toMatch(/@font-face/i);
      expect(text, file).not.toMatch(/https?:\/\//i);
    }
  });
  it('keep every raw colour in the tokens file (the others use var(--...))', () => {
    for (const file of css.filter((p) => !p.endsWith('tokens.css'))) {
      const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(text, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(text, file).not.toMatch(/\b(rgb|rgba|hsl|hsla)\s*\(/i);
    }
  });
  it('define a light and a dark theme with the same tokens', () => {
    const text = fs.readFileSync(path.join(dir, 'styles', 'tokens.css'), 'utf8');
    expect(text).toContain("[data-theme='dark']");
    expect(text).toContain("[data-theme='light']");
    expect(text).toContain('prefers-color-scheme: dark');
    const names = (block: string) =>
      [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string).sort();
    const light = /:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
    const dark = /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
    const colours = (n: string[]) =>
      n.filter(
        (x) => !/^--(font|text|leading|space|measure|radius|rule-width|focus|transition)/.test(x),
      );
    expect(colours(names(dark))).toEqual(colours(names(light)));
  });
});

describe('the source never sets styles or loads things from elsewhere', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(p) && !/\.test\./.test(p)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src', 'app'));
  it('has no style prop, dangerouslySetInnerHTML, <img>, <script> or remote src in src/app', () => {
    const problems: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      if (/\sstyle=\{/.test(text) || /\sstyle="/.test(text))
        problems.push(`${rel}: style attribute`);
      if (/dangerouslySetInnerHTML/.test(text)) problems.push(`${rel}: dangerouslySetInnerHTML`);
      if (/<(img|script|iframe|object|embed)[\s>]/.test(text)) problems.push(`${rel}: raw element`);
      if (/(src|href)=["']https?:\/\//.test(text)) problems.push(`${rel}: external URL`);
      if (/from ['"]next\/(font|image|script)/.test(text))
        problems.push(`${rel}: next font/image/script`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the unsafe-thing detector itself catches problems', () => {
  it.each([
    ['<p style="color:red">x</p>', 'inline style'],
    ['<style>p{}</style>', '<style>'],
    ['<script>1</script>', '<script>'],
    ['<img src="/a.png">', '<img>'],
    ['<a href="https://example.com">x</a>', 'external URL'],
    ['<a href="//example.com">x</a>', 'external URL'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript'],
    ['<button onclick="x()">x</button>', 'event handler'],
    ['<link rel="stylesheet" href="/a.css">', '<link>'],
    ['<p>text <details><summary>x</summary></details></p>', 'block in p'],
    ['<p>text <div>x</div></p>', 'div in p'],
  ])('flags %s', (html) => {
    expect(unsafeThings(html)).not.toEqual([]);
  });
  it('accepts a normal page fragment', () => {
    expect(
      unsafeThings('<a href="/trades/1">x</a><svg viewBox="0 0 1 1"><rect width="1"/></svg>'),
    ).toEqual([]);
  });
});

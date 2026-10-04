import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ENTRIES, scanApp, scanSource } from '../helpers/guard-scan';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('every entry point is behind the guard', () => {
  const scan = scanApp(ROOT);

  it('finds the pages and actions (the scanner is not silently empty)', () => {
    const kinds = new Set(scan.entries.map((e) => e.kind));
    expect(kinds.has('page')).toBe(true);
    expect(kinds.has('action')).toBe(true);
    expect(scan.entries.length).toBeGreaterThan(15);
  });

  it('has no unguarded page, route handler or server action', () => {
    expect(scan.problems).toEqual([]);
  });

  it('allows only the login page and login action to be public', () => {
    const publicOnes = scan.entries
      .filter((e) => e.wrapper === 'publicPage' || e.wrapper === 'publicAction')
      .map((e) => `${e.file.replaceAll('\\', '/')}#${e.exportName}`)
      .sort();
    expect(publicOnes).toEqual([...PUBLIC_ENTRIES].sort());
  });
});

describe('the scanner itself catches mistakes', () => {
  const imp = `import { guardedAction, guardedPage } from '../_lib/guard';\n`;

  it('flags an unwrapped server action', () => {
    const s = scanSource(
      'src/app/x/actions.ts',
      `'use server';\n${imp}export async function bad(formData: FormData) {}\n`,
    );
    expect(s.problems.join()).toContain('"bad" is not wrapped');
  });

  it('flags an unwrapped page and a page wrapped by the wrong wrapper', () => {
    expect(
      scanSource('src/app/x/page.tsx', `export default function P() { return null; }\n`).problems,
    ).not.toEqual([]);
    expect(
      scanSource('src/app/x/page.tsx', `${imp}export default guardedAction(async () => null);\n`)
        .problems,
    ).not.toEqual([]);
  });

  it('flags an unwrapped route handler but allows route config exports', () => {
    const bad = scanSource(
      'src/app/api/x/route.ts',
      `export async function GET() { return new Response(); }\n`,
    );
    expect(bad.problems.join()).toContain('"GET"');
    const ok = scanSource(
      'src/app/api/x/route.ts',
      `import { guardedRoute } from '../../_lib/guard';\nexport const dynamic = 'force-dynamic';\nexport const GET = guardedRoute(async () => new Response());\n`,
    );
    expect(ok.problems).toEqual([]);
  });

  it('flags inline server actions, re-exports and layouts that touch data', () => {
    expect(
      scanSource(
        'src/app/x/page.tsx',
        `${imp}export default guardedPage(() => { async function a() { 'use server'; } return null; });\n`,
      ).problems.join(),
    ).toContain('inline');
    expect(
      scanSource(
        'src/app/x/actions.ts',
        `'use server';\nexport { a } from './other';\n`,
      ).problems.join(),
    ).toContain('re-exports');
    expect(
      scanSource(
        'src/app/layout.tsx',
        `import { listAccounts } from '@/data/accounts';\nexport default function L() { return null; }\n`,
      ).problems.join(),
    ).toContain('layouts must not touch data');
  });

  it('flags a guard wrapper that is not the shared one', () => {
    const s = scanSource(
      'src/app/x/actions.ts',
      `'use server';\nconst guardedAction = (f: unknown) => f;\nexport const a = guardedAction(async () => {});\n`,
    );
    expect(s.problems.join()).toContain('must be imported from the shared guard');
  });
});

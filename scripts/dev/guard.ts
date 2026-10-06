import path from 'node:path';

/**
 * Safety guard for `npm run dev:seed`. The seed fills a DEMO database with made-up trades. It must
 * never be able to touch the real journal, so it only runs when DATABASE_URL names a file that
 * (a) is set explicitly, (b) has "demo" in its file name, and (c) is not the real journal file.
 * Pure: it only looks at text and paths and opens nothing.
 */

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}

/** The real journal file when DATABASE_URL is not set (see src/config/env.ts). */
export const REAL_DATABASE_FILE = 'data/houcine-trades.db';

const samePath = (a: string, b: string) =>
  path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

/** Returns the absolute path of the demo file, or throws SeedRefusedError saying why not. */
export function resolveDemoTarget(databaseUrl: string | undefined, cwd: string): string {
  const raw = (databaseUrl ?? '').trim();
  if (raw === '') {
    throw new SeedRefusedError(
      'DATABASE_URL is not set. Set it to a demo file, for example file:./data/demo.db, so the real journal can never be used by mistake.',
    );
  }
  const file = raw.replace(/^file:/, '');
  if (file === ':memory:' || file === '') {
    throw new SeedRefusedError('DATABASE_URL must be a file with "demo" in its name, not memory.');
  }
  const resolved = path.resolve(cwd, file);
  const real = path.resolve(cwd, REAL_DATABASE_FILE);
  if (samePath(resolved, real)) {
    throw new SeedRefusedError(
      `DATABASE_URL points at the real journal (${resolved}). Nothing was opened or changed.`,
    );
  }
  if (!/demo/i.test(path.basename(resolved))) {
    throw new SeedRefusedError(
      `DATABASE_URL points at ${resolved}, whose file name does not contain "demo". The seed only runs on a demo file such as data/demo.db. Nothing was opened or changed.`,
    );
  }
  return resolved;
}

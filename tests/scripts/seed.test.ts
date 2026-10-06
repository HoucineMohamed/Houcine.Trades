import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDashboard } from '@/data/dashboard';
import { listAccounts } from '@/data/accounts';
import { listJournal } from '@/data/journal-view';
import { listSetups } from '@/data/setups';
import { parseJournalQuery } from '@/domain/trades/table';
import { REAL_DATABASE_FILE, resolveDemoTarget, SeedRefusedError } from '../../scripts/dev/guard';
import { DEMO_ACCOUNT_NAME, seedDemo } from '../../scripts/dev/seed-demo';
import { memoryDb } from '../helpers/db';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = new Date('2026-06-15T14:30:00.000Z');

describe('the demo seed guard', () => {
  const cwd = '/work/project';
  it('accepts a file with "demo" in its name and returns its absolute path', () => {
    expect(resolveDemoTarget('file:./data/demo.db', cwd)).toBe(path.resolve(cwd, 'data/demo.db'));
    expect(resolveDemoTarget('file:./data/my-DEMO-journal.db', cwd)).toContain(
      'my-DEMO-journal.db',
    );
    expect(resolveDemoTarget('./data/demo.sqlite', cwd)).toContain('demo.sqlite');
  });
  it('refuses when DATABASE_URL is not set (it never falls back to the real file)', () => {
    for (const v of [undefined, '', '   ']) {
      expect(() => resolveDemoTarget(v, cwd)).toThrow(SeedRefusedError);
    }
  });
  it('refuses the real journal file, however it is written', () => {
    for (const v of [
      `file:./${REAL_DATABASE_FILE}`,
      `file:${REAL_DATABASE_FILE}`,
      `file:./data/../${REAL_DATABASE_FILE}`,
      `file:${path.resolve(cwd, REAL_DATABASE_FILE)}`,
      `file:./DATA/HOUCINE-TRADES.DB`,
    ]) {
      expect(() => resolveDemoTarget(v, cwd), v).toThrow(/real journal/);
    }
  });
  it('refuses any file whose name does not contain "demo"', () => {
    for (const v of ['file:./data/other.db', 'file:./data/journal.db', 'file:./demo/real.db']) {
      expect(() => resolveDemoTarget(v, cwd), v).toThrow(/does not contain "demo"/);
    }
  });
  it('refuses memory and a "demo" folder trick on the real file name', () => {
    expect(() => resolveDemoTarget('file::memory:', cwd)).toThrow(SeedRefusedError);
    expect(() => resolveDemoTarget(':memory:', cwd)).toThrow(SeedRefusedError);
    expect(() => resolveDemoTarget('file:./demo/houcine-trades.db', cwd)).toThrow(SeedRefusedError);
  });
});

describe('seedDemo', () => {
  it('creates a clearly named DEMO account with every kind of trade', () => {
    const db = memoryDb();
    const s = seedDemo(db, NOW);
    const [account] = listAccounts(db);
    expect(account?.name).toBe(DEMO_ACCOUNT_NAME);
    expect(account?.mode).toBe('paper');
    expect(listSetups(db).length).toBe(3);
    const d = loadDashboard(db, s.accountId, NOW);
    expect(d.counts).toEqual({ total: 43, planned: 2, open: 2, closed: 38 });
    expect(s).toMatchObject({ closed: 38, open: 2, planned: 2, cancelled: 1 });
  });

  it('every demo trade is marked as demo in its notes or setup', () => {
    const db = memoryDb();
    seedDemo(db, NOW);
    const rows = db.$client.prepare('SELECT plan_notes FROM trades').all() as {
      plan_notes: string;
    }[];
    expect(rows.every((r) => r.plan_notes.startsWith('DEMO'))).toBe(true);
  });

  it('never triggers a halt, and shows the two currencies separately', () => {
    const db = memoryDb();
    const { accountId } = seedDemo(db, NOW);
    const d = loadDashboard(db, accountId, NOW);
    expect(d.risk.halts).toEqual([]);
    expect(d.risk.equity).not.toBeNull();
    expect(d.stats.currencies.map((c) => c.quoteCurrency)).toEqual(['USDT', 'EUR']);
    expect(d.stats.currencies[0]?.overall.flags.tradesWithExcludedFees).toBe(1);
    expect(d.usage.openRisk.problem).toBeNull();
    expect(d.usage.openRisk.reached).toBe(false);
  });

  it('includes one override example, flagged in the journal', () => {
    const db = memoryDb();
    const { accountId } = seedDemo(db, NOW);
    const v = listJournal(db, accountId, parseJournalQuery({ override: '1' }));
    expect(v.page.total).toBe(1);
  });

  it('is deterministic: the same demo every time', () => {
    const a = memoryDb();
    const b = memoryDb();
    seedDemo(a, NOW);
    seedDemo(b, NOW);
    const dump = (db: ReturnType<typeof memoryDb>) =>
      db.$client
        .prepare('SELECT symbol, direction, entry_price, exit_price, size FROM trades ORDER BY id')
        .all();
    expect(dump(a)).toEqual(dump(b));
  });

  it('refuses a database that already has an account, and adds nothing', () => {
    const db = memoryDb();
    seedDemo(db, NOW);
    const before = db.$client.prepare('SELECT count(*) c FROM trades').get();
    expect(() => seedDemo(db, NOW)).toThrow(SeedRefusedError);
    expect(db.$client.prepare('SELECT count(*) c FROM trades').get()).toEqual(before);
  });
});

describe('npm run dev:seed (the real command)', () => {
  const run = (databaseUrl: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
    return spawnSync('npx', ['tsx', '--conditions=react-server', 'scripts/dev/seed.ts'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  };

  it('refuses the real journal and does not create or touch it', () => {
    const real = path.join(ROOT, REAL_DATABASE_FILE);
    const existed = fs.existsSync(real);
    const mtime = existed ? fs.statSync(real).mtimeMs : null;
    const r = run(`file:./${REAL_DATABASE_FILE}`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('real journal');
    expect(r.stdout).not.toContain('Demo database file');
    expect(fs.existsSync(real)).toBe(existed);
    if (existed) expect(fs.statSync(real).mtimeMs).toBe(mtime);
  }, 130_000);

  it('refuses when DATABASE_URL is unset or not a demo file, creating nothing', () => {
    const other = path.join(ROOT, 'data', 'not-a-seed-target.db');
    expect(run(undefined).status).toBe(2);
    const r = run(`file:${other}`);
    expect(r.status).toBe(2);
    expect(fs.existsSync(other)).toBe(false);
  }, 130_000);

  it('seeds a demo file, printing which file it uses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-demo-'));
    try {
      const file = path.join(dir, 'demo.db');
      const r = run(`file:${file}`);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Demo database file: ${file}`);
      expect(r.stdout).toContain('DEMO Paper Account');
      // a second run refuses and adds nothing
      const again = run(`file:${file}`);
      expect(again.status).toBe(2);
      expect(again.stderr).toContain('already contains accounts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);
});

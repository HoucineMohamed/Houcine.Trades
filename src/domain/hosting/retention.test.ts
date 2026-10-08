import { describe, expect, it } from 'vitest';
import {
  backupObjectKey,
  parseBackupKey,
  planRetention,
  RETENTION,
  type BackupKind,
  type BackupName,
} from './retention';

const P = 'backups';
const at = (iso: string) => new Date(iso);
const mk = (iso: string, kind: BackupKind = 'daily', m = 5): BackupName => ({
  key: backupObjectKey(P, at(iso), kind, m),
  at: at(iso),
  kind,
  migrations: m,
});

describe('backup names', () => {
  it('round-trips', () => {
    const key = backupObjectKey(P, at('2026-10-08T03:15:00Z'), 'daily', 5);
    expect(key).toBe('backups/20261008T031500Z-daily-m5.htbk');
    expect(parseBackupKey(key, P)).toEqual({
      key,
      at: at('2026-10-08T03:15:00Z'),
      kind: 'daily',
      migrations: 5,
    });
  });
  it.each([
    'backups/notes.txt',
    'other/20261008T031500Z-daily-m5.htbk',
    'backups/20261308T031500Z-daily-m5.htbk',
    'backups/20261008T031500Z-weekly-m5.htbk',
    'backups/20261008T031500Z-daily-m5.htbk.tmp',
    'backups/../20261008T031500Z-daily-m5.htbk',
    'backups/20261008T031500Z-daily-m.htbk',
  ])('does not recognise %s (so retention never touches it)', (key) => {
    expect(parseBackupKey(key, P)).toBeNull();
  });
  it('refuses a bad migration count', () => {
    expect(() => backupObjectKey(P, new Date(), 'daily', -1)).toThrow();
    expect(() => backupObjectKey(P, new Date(), 'daily', 1.5)).toThrow();
  });
});

describe('retention policy', () => {
  const NOW = at('2026-10-08T12:00:00Z');

  it('keeps one per day for 7 days, one per week for 4, one per month for 6', () => {
    const items: BackupName[] = [];
    for (let i = 0; i < 200; i++) {
      const d = new Date(NOW.getTime() - i * 86_400_000 - 3600_000);
      items.push(mk(d.toISOString()));
    }
    const plan = planRetention(items, NOW);
    const kept = items.filter((i) => plan.keep.includes(i.key));
    expect(kept.length).toBeLessThanOrEqual(7 + 4 + 6 + 3);
    expect(kept.length).toBeGreaterThanOrEqual(7 + 3);
    // the seven newest days are all there
    for (let i = 0; i < 7; i++) expect(plan.keep).toContain(items[i]?.key);
    // a backup from 150 days ago is gone, unless it is the newest of its month
    expect(plan.remove.length).toBeGreaterThan(150);
    expect(plan.keep.length + plan.remove.length).toBe(items.length);
  });

  it('keeps only the newest backup of a day', () => {
    const a = mk('2026-10-07T01:00:00Z');
    const b = mk('2026-10-07T23:00:00Z');
    const old = mk('2026-06-01T01:00:00Z');
    const old2 = mk('2026-06-01T02:00:00Z');
    const plan = planRetention([a, b, old, old2], NOW);
    expect(plan.keep).toContain(b.key);
    expect(plan.remove).toContain(a.key);
    expect(plan.remove).toContain(old.key);
    expect(plan.keep).toContain(old2.key);
  });

  it('never removes manual backups, the newest of each kind, or anything under 24 hours old', () => {
    const manual = mk('2026-01-01T00:00:00Z', 'manual');
    const lonePre = mk('2026-02-01T00:00:00Z', 'pre-migration');
    const fresh1 = mk('2026-10-08T11:00:00Z');
    const fresh2 = mk('2026-10-08T10:00:00Z');
    const plan = planRetention([manual, lonePre, fresh1, fresh2], NOW);
    expect(plan.remove).toEqual([]);
  });

  it('keeps the 5 newest pre-migration backups', () => {
    const pre: BackupName[] = [];
    for (let i = 0; i < 9; i++) pre.push(mk(`2026-0${i + 1}-15T00:00:00Z`, 'pre-migration'));
    const plan = planRetention(pre, NOW);
    for (const p of pre.slice(4)) expect(plan.keep).toContain(p.key);
  });

  it('removes nothing when the list is empty, and never everything', () => {
    expect(planRetention([], NOW)).toEqual({ keep: [], remove: [] });
    const only = mk('2020-01-01T00:00:00Z');
    expect(planRetention([only], NOW).remove).toEqual([]);
  });

  it('a clock in the past (items dated in the future) deletes nothing new', () => {
    const future = mk('2030-01-01T00:00:00Z');
    const plan = planRetention([future, mk('2020-01-01T00:00:00Z')], NOW);
    expect(plan.keep).toContain(future.key);
  });

  it('after a long outage the newest backups are still kept (periods are counted among those that exist)', () => {
    const items = [
      mk('2026-03-01T00:00:00Z'),
      mk('2026-03-02T00:00:00Z'),
      mk('2026-03-03T00:00:00Z'),
    ];
    const plan = planRetention(items, NOW);
    expect(plan.remove).toEqual([]);
  });

  it('property: for random inputs the newest backup and the newest of each kind always survive', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const kinds: BackupKind[] = ['daily', 'pre-migration', 'manual'];
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rnd() * 60);
      const items: BackupName[] = [];
      const used = new Set<string>();
      for (let i = 0; i < n; i++) {
        const t = new Date(
          NOW.getTime() - Math.floor(rnd() * 400 * 86_400_000) + Math.floor(rnd() * 3 * 86_400_000),
        );
        const item = mk(
          t.toISOString().replace(/\.\d+Z$/, 'Z'),
          kinds[Math.floor(rnd() * 3)] ?? 'daily',
        );
        if (used.has(item.key)) continue;
        used.add(item.key);
        items.push(item);
      }
      const plan = planRetention(items, NOW);
      const byTime = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());
      expect(plan.keep).toContain(byTime[0]?.key);
      for (const kind of kinds) {
        const newestOfKind = byTime.find((i) => i.kind === kind);
        if (newestOfKind) expect(plan.keep).toContain(newestOfKind.key);
      }
      expect(plan.keep.length).toBeGreaterThan(0);
      expect(new Set([...plan.keep, ...plan.remove]).size).toBe(items.length);
    }
  });

  it('the numbers are fixed in code', () => {
    expect(RETENTION).toEqual({ daily: 7, weekly: 4, monthly: 6, preMigration: 5 });
  });
});

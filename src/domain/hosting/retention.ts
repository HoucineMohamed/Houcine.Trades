/**
 * Backup names and the retention policy. Pure: it only looks at names and times.
 *
 * A backup object key is  <prefix>/<UTC time>-<kind>-m<migrations>.htbk , for example
 *   backups/20261008T031500Z-daily-m5.htbk
 * Anything under the prefix that does not match this exact shape is NEVER touched (not listed as a
 * candidate for deletion): the bucket may hold other files.
 *
 * Policy (the numbers are in code, not in settings): keep the newest backup of each of the last 7
 * days, 4 weeks and 6 months that HAVE backups, the 5 newest pre-migration backups, and every manual
 * backup. On top of that two invariants hold for any input (a test proves it with random data):
 * the newest backup is never removed, and the newest of each kind is never removed.
 */

import { BACKUP_KINDS, type BackupKind } from './kinds';

export { BACKUP_KINDS, type BackupKind };

export const RETENTION = { daily: 7, weekly: 4, monthly: 6, preMigration: 5 } as const;

/** A backup younger than this is never removed, whatever else the policy says. */
export const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface BackupName {
  key: string;
  at: Date;
  kind: BackupKind;
  /** How many migrations the database had applied when the backup was taken. */
  migrations: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function compactUtc(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

export function backupObjectKey(
  prefix: string,
  at: Date,
  kind: BackupKind,
  migrations: number,
): string {
  // the name pattern reads at most four digits: a longer count would make a backup nobody can list
  if (!Number.isInteger(migrations) || migrations < 0 || migrations > 9999) {
    throw new Error('invalid migration count');
  }
  return `${prefix}/${compactUtc(at)}-${kind}-m${migrations}.htbk`;
}

const NAME =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(daily|pre-migration|manual)-m(\d{1,4})\.htbk$/;

/** The parsed name, or null when the key is not one of ours (never a candidate for deletion). */
export function parseBackupKey(key: string, prefix: string): BackupName | null {
  if (!key.startsWith(`${prefix}/`)) return null;
  const rest = key.slice(prefix.length + 1);
  const m = NAME.exec(rest);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, kind, mig] = m;
  const at = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  // reject impossible dates such as 20261340T...
  if (compactUtc(at) !== rest.slice(0, 16)) return null;
  return { key, at, kind: kind as BackupKind, migrations: Number(mig) };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
function weekKey(d: Date): string {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return dayKey(monday);
}

const newestFirst = (a: BackupName, b: BackupName) =>
  b.at.getTime() - a.at.getTime() || (a.key < b.key ? 1 : -1);

/** The newest item of each of the `count` most recent periods that have any item. */
function keepPerPeriod(
  items: readonly BackupName[],
  periodOf: (d: Date) => string,
  count: number,
  keep: Set<string>,
): void {
  const seen = new Set<string>();
  for (const item of [...items].sort(newestFirst)) {
    const p = periodOf(item.at);
    if (seen.has(p)) continue;
    if (seen.size >= count) break;
    seen.add(p);
    keep.add(item.key);
  }
}

export interface RetentionPlan {
  keep: string[];
  remove: string[];
}

/** Names dated later than this (plus a little clock difference) are not real backups of ours. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function planRetention(
  all: readonly BackupName[],
  now: Date,
  policy: typeof RETENTION = RETENTION,
): RetentionPlan {
  // A name dated in the FUTURE (a clock problem, or an object someone planted to push real backups out)
  // takes no slot and counts for no invariant. It is never deleted either: it is left for a human.
  const items = all.filter((i) => i.at.getTime() <= now.getTime() + FUTURE_SKEW_MS);
  const future = all.filter((i) => i.at.getTime() > now.getTime() + FUTURE_SKEW_MS);
  if (items.length === 0) return { keep: future.map((f) => f.key), remove: [] };
  const keep = new Set<string>(future.map((f) => f.key));
  const sorted = [...items].sort(newestFirst);

  // invariants first: the newest overall, and the newest of every kind
  const newest = sorted[0];
  if (newest) keep.add(newest.key);
  for (const kind of BACKUP_KINDS) {
    const k = sorted.find((i) => i.kind === kind);
    if (k) keep.add(k.key);
  }
  for (const item of items) {
    if (item.kind === 'manual') keep.add(item.key); // a manual backup is never deleted by the schedule
    if (now.getTime() - item.at.getTime() < RETENTION_GRACE_MS) keep.add(item.key); // too new
  }

  const scheduled = items.filter((i) => i.kind !== 'manual');
  keepPerPeriod(scheduled, dayKey, policy.daily, keep);
  keepPerPeriod(scheduled, weekKey, policy.weekly, keep);
  keepPerPeriod(scheduled, monthKey, policy.monthly, keep);
  for (const item of scheduled
    .filter((i) => i.kind === 'pre-migration')
    .sort(newestFirst)
    .slice(0, policy.preMigration)) {
    keep.add(item.key);
  }

  const remove = sorted.filter((i) => !keep.has(i.key)).map((i) => i.key);
  return {
    keep: [...future, ...sorted].filter((i) => keep.has(i.key)).map((i) => i.key),
    remove,
  };
}

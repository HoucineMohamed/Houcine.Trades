/**
 * Is the backup system healthy? Pure. A missing backup is a problem the owner must see: the state is
 * "ok" only when there is a verified backup younger than 36 hours and the latest attempt did not fail.
 */

export const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;

export type BackupState = 'ok' | 'last_failed' | 'stale' | 'never' | 'pending' | 'unknown';

export interface BackupHealthInput {
  /** When the last VERIFIED backup finished, or null. */
  lastSuccessAt: string | null;
  /** When the last attempt failed, or null. */
  lastFailureAt: string | null;
  /** When backups were first expected to run (first start with backups configured), or null. */
  trackingSince: string | null;
  now: Date;
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : Number.NaN;
};

export function backupState(i: BackupHealthInput): BackupState {
  const now = i.now.getTime();
  const ok = ms(i.lastSuccessAt);
  const bad = ms(i.lastFailureAt);
  const since = ms(i.trackingSince);
  // a time that cannot be read is "unknown", never "fine"
  if (!Number.isFinite(now) || Number.isNaN(ok) || Number.isNaN(bad) || Number.isNaN(since)) {
    return 'unknown';
  }
  if (ok === null) {
    if (bad !== null) return 'never';
    if (since !== null && now - since > BACKUP_STALE_MS) return 'never';
    return since === null ? 'unknown' : 'pending';
  }
  if (now - ok > BACKUP_STALE_MS) return 'stale';
  if (bad !== null && bad > ok) return 'last_failed';
  return 'ok';
}

/** Shown in the header: everything except a healthy state and the first hours after setup. */
export const backupIsProblem = (s: BackupState): boolean => s !== 'ok' && s !== 'pending';

export const BACKUP_STATE_WORDS: Record<BackupState, string> = {
  ok: 'The latest backup is verified and less than 36 hours old.',
  last_failed:
    'The latest backup attempt failed. An older verified backup exists, and the next attempt will retry.',
  stale: 'No verified backup in the last 36 hours.',
  never: 'No verified backup exists yet, and one was expected.',
  pending: 'Waiting for the first backup (it runs soon after the first start).',
  unknown: 'The backup status could not be read.',
};

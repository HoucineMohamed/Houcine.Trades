/**
 * Is the backup system healthy? Pure. A missing backup is a problem the owner must see: the state is
 * "ok" only when there is a verified backup younger than 36 hours and the latest attempt did not fail.
 */

import type { BackupErrorCode } from './kinds';

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
  // a success dated in the future (beyond a few minutes of clock difference) cannot be trusted
  if (ok !== null && ok > now + 5 * 60_000) return 'unknown';
  if (ok === null) {
    if (bad !== null) return 'never';
    if (since !== null && now - since > BACKUP_STALE_MS) return 'never';
    return since === null ? 'unknown' : 'pending';
  }
  if (now - ok > BACKUP_STALE_MS) return 'stale';
  if (bad !== null && bad > ok) return 'last_failed';
  return 'ok';
}

/**
 * Should the "no verified backup for a day and a half" notice go out? Only when 36 hours really have
 * passed without one: a stale backup, or no backup at all since backups were expected.
 */
export function needsStaleNotice(i: BackupHealthInput): boolean {
  const state = backupState(i);
  if (state === 'stale') return true;
  if (state !== 'never') return false;
  const since = i.trackingSince === null ? Number.NaN : Date.parse(i.trackingSince);
  return Number.isFinite(since) && i.now.getTime() - since > BACKUP_STALE_MS;
}

/** Short text for the header badge (only shown for the states that are a problem). */
export const BACKUP_HEADER_WORDS: Record<BackupState, string> = {
  ok: 'Backups: ok',
  pending: 'Backups: waiting for the first one',
  last_failed: 'Backups: last attempt failed',
  stale: 'Backups: none in the last day and a half',
  never: 'Backups: none yet',
  unknown: 'Backups: status unknown',
};

/** What a failed backup's short code means, in words (the database stores only the code). */
export const BACKUP_ERROR_WORDS: Record<BackupErrorCode, string> = {
  snapshot_failed: 'the database snapshot could not be taken',
  snapshot_corrupt: 'the snapshot failed its integrity check',
  encrypt_failed: 'the snapshot could not be encrypted',
  upload_failed: 'the upload was refused or incomplete',
  verify_failed: 'the uploaded copy did not match when read back',
  store_unreachable: 'the backup storage could not be reached',
  store_denied: 'the backup storage refused the keys',
  not_configured: 'the backup settings are incomplete',
  unexpected: 'an unexpected problem',
};

/** Why a staged restore was not applied, in words (the file on the disk keeps only a short code). */
export const RESTORE_FAILURE_WORDS: Record<string, string> = {
  changed: 'the staged file changed after it was checked',
  integrity_failed: 'the staged file failed its integrity check',
  newer_than_app: 'the backup comes from a newer version of the app',
  swap_failed: 'the files could not be swapped (the previous database was put back)',
  invalid: 'the staged restore could not be read',
  expired: 'it waited more than 6 hours and was discarded',
};

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

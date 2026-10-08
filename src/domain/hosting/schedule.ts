/**
 * When is a backup due? Pure. One verified backup a day; after a failure, try again every 30 minutes
 * until one succeeds (a failed night must not wait for the next night).
 */

export const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_RETRY_MS = 30 * 60 * 1000;

export interface ScheduleInput {
  lastSuccessAt: string | null;
  /** The newest attempt of any outcome, or null. */
  lastAttemptAt: string | null;
  now: Date;
}

export function backupDue(i: ScheduleInput): boolean {
  const now = i.now.getTime();
  if (!Number.isFinite(now)) return false;
  const parse = (v: string | null) => (v === null ? null : Date.parse(v));
  const ok = parse(i.lastSuccessAt);
  const attempt = parse(i.lastAttemptAt);
  // A time that cannot be read must not stop backups forever: treat it as "never happened".
  // A time in the FUTURE (a clock moved back, a corrupt row) would block backups until the clock catches
  // up, so it counts as "never happened" too.
  const usable = (v: number | null): number | null =>
    v !== null && Number.isFinite(v) && v <= now ? v : null;
  const okMs = usable(ok);
  const attemptMs = usable(attempt);
  if (okMs !== null && now - okMs < BACKUP_EVERY_MS) return false;
  if (attemptMs !== null && now - attemptMs < BACKUP_RETRY_MS) return false;
  return true;
}

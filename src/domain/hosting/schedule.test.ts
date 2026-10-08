import { describe, expect, it } from 'vitest';
import { BACKUP_EVERY_MS, BACKUP_RETRY_MS, backupDue } from './schedule';

const NOW = new Date('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('backupDue', () => {
  it('is due on a fresh install', () => {
    expect(backupDue({ lastSuccessAt: null, lastAttemptAt: null, now: NOW })).toBe(true);
  });
  it('is not due within a day of a success', () => {
    expect(
      backupDue({
        lastSuccessAt: ago(BACKUP_EVERY_MS - 1),
        lastAttemptAt: ago(BACKUP_EVERY_MS - 1),
        now: NOW,
      }),
    ).toBe(false);
  });
  it('is due after a day', () => {
    expect(
      backupDue({
        lastSuccessAt: ago(BACKUP_EVERY_MS),
        lastAttemptAt: ago(BACKUP_EVERY_MS),
        now: NOW,
      }),
    ).toBe(true);
  });
  it('after a failure it retries every 30 minutes, not sooner', () => {
    const base = { lastSuccessAt: ago(2 * BACKUP_EVERY_MS), now: NOW };
    expect(backupDue({ ...base, lastAttemptAt: ago(BACKUP_RETRY_MS - 1) })).toBe(false);
    expect(backupDue({ ...base, lastAttemptAt: ago(BACKUP_RETRY_MS) })).toBe(true);
  });
  it('unreadable times never stop backups for good', () => {
    expect(backupDue({ lastSuccessAt: 'junk', lastAttemptAt: 'junk', now: NOW })).toBe(true);
    expect(backupDue({ lastSuccessAt: null, lastAttemptAt: null, now: new Date('x') })).toBe(false);
  });
});

describe('timestamps in the future never stop backups', () => {
  const future = '2030-01-01T00:00:00.000Z';
  it('a future success or attempt counts as "never happened"', () => {
    expect(backupDue({ lastSuccessAt: future, lastAttemptAt: null, now: NOW })).toBe(true);
    expect(backupDue({ lastSuccessAt: null, lastAttemptAt: future, now: NOW })).toBe(true);
  });
  it('a fresh success with a very recent failure is not due; a stale attempt with a fresh success is not due', () => {
    expect(backupDue({ lastSuccessAt: ago(3_600_000), lastAttemptAt: ago(60_000), now: NOW })).toBe(
      false,
    );
    expect(
      backupDue({ lastSuccessAt: ago(3_600_000), lastAttemptAt: ago(2 * 3_600_000), now: NOW }),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { BACKUP_STALE_MS, backupIsProblem, backupState } from './backup-health';

const NOW = new Date('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 3_600_000;
const base = { lastSuccessAt: null, lastFailureAt: null, trackingSince: ago(100 * H), now: NOW };

describe('backup state', () => {
  it('is ok with a verified backup under 36 hours old', () => {
    expect(backupState({ ...base, lastSuccessAt: ago(35 * H) })).toBe('ok');
  });
  it('is stale at 36 hours and over (the boundary is exact)', () => {
    expect(backupState({ ...base, lastSuccessAt: ago(BACKUP_STALE_MS) })).toBe('ok');
    expect(backupState({ ...base, lastSuccessAt: ago(BACKUP_STALE_MS + 1) })).toBe('stale');
  });
  it('shows a failed latest attempt even when an older backup is fresh', () => {
    expect(backupState({ ...base, lastSuccessAt: ago(5 * H), lastFailureAt: ago(1 * H) })).toBe(
      'last_failed',
    );
    expect(backupState({ ...base, lastSuccessAt: ago(1 * H), lastFailureAt: ago(5 * H) })).toBe(
      'ok',
    );
  });
  it('never having a backup is a problem once one was expected', () => {
    expect(backupState({ ...base })).toBe('never');
    expect(backupState({ ...base, trackingSince: ago(2 * H) })).toBe('pending');
    expect(backupState({ ...base, trackingSince: ago(2 * H), lastFailureAt: ago(1 * H) })).toBe(
      'never',
    );
  });
  it('an unreadable time or no tracking start is unknown, never ok', () => {
    expect(backupState({ ...base, lastSuccessAt: 'garbage' })).toBe('unknown');
    expect(backupState({ ...base, lastFailureAt: 'garbage', lastSuccessAt: ago(H) })).toBe(
      'unknown',
    );
    expect(backupState({ ...base, trackingSince: null })).toBe('unknown');
    expect(backupState({ ...base, now: new Date('nope') })).toBe('unknown');
  });
  it('which states are problems', () => {
    expect(
      (['ok', 'pending', 'last_failed', 'stale', 'never', 'unknown'] as const).map(backupIsProblem),
    ).toEqual([false, false, true, true, true, true]);
  });
});

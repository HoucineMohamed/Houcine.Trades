import { describe, expect, it } from 'vitest';
import {
  BACKUP_ERROR_WORDS,
  BACKUP_HEADER_WORDS,
  BACKUP_STALE_MS,
  BACKUP_STATE_WORDS,
  backupIsProblem,
  backupState,
  needsStaleNotice,
} from './backup-health';
import { BACKUP_ERROR_CODES } from './kinds';

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

describe('the stale notice', () => {
  it('goes out only after 36 hours really passed', () => {
    expect(needsStaleNotice({ ...base, lastSuccessAt: ago(35 * H) })).toBe(false);
    expect(needsStaleNotice({ ...base, lastSuccessAt: ago(37 * H) })).toBe(true);
    expect(needsStaleNotice({ ...base })).toBe(true); // never, and expected for 100 hours
    expect(needsStaleNotice({ ...base, trackingSince: ago(2 * H), lastFailureAt: ago(H) })).toBe(
      false,
    ); // first hours
    expect(needsStaleNotice({ ...base, lastSuccessAt: 'junk' })).toBe(false); // unknown is shown, not announced
  });
});

describe('words', () => {
  it('every state and every error code has plain words (adding one without words fails here)', () => {
    for (const s of Object.keys(BACKUP_STATE_WORDS)) expect(BACKUP_HEADER_WORDS).toHaveProperty(s);
    for (const c of BACKUP_ERROR_CODES) expect(BACKUP_ERROR_WORDS[c].length).toBeGreaterThan(10);
  });
  it('no advice or judging words', () => {
    const all = [
      ...Object.values(BACKUP_STATE_WORDS),
      ...Object.values(BACKUP_HEADER_WORDS),
      ...Object.values(BACKUP_ERROR_WORDS),
    ].join(' ');
    expect(all).not.toMatch(/\b(good|bad|should|must|great|terrible)\b/i);
  });
});

describe('clock problems and exact boundaries', () => {
  const future = '2030-01-01T00:00:00.000Z';
  it('a success dated in the future is "unknown", never a healthy backup', () => {
    expect(backupState({ ...base, lastSuccessAt: future })).toBe('unknown');
    expect(backupIsProblem(backupState({ ...base, lastSuccessAt: future }))).toBe(true);
  });
  it('a few minutes of clock difference are tolerated', () => {
    expect(
      backupState({ ...base, lastSuccessAt: new Date(NOW.getTime() + 60_000).toISOString() }),
    ).toBe('ok');
  });
  it('the tracking window is exactly 36 hours', () => {
    const t = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(backupState({ ...base, trackingSince: t(BACKUP_STALE_MS) })).toBe('pending');
    expect(backupState({ ...base, trackingSince: t(BACKUP_STALE_MS + 1) })).toBe('never');
    expect(needsStaleNotice({ ...base, trackingSince: t(BACKUP_STALE_MS) })).toBe(false);
    expect(needsStaleNotice({ ...base, trackingSince: t(BACKUP_STALE_MS + 1) })).toBe(true);
  });
  it('a stale success with a later failure is stale', () => {
    expect(backupState({ ...base, lastSuccessAt: ago(40 * H), lastFailureAt: ago(H) })).toBe(
      'stale',
    );
  });
});

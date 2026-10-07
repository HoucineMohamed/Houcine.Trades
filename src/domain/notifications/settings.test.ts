import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import { makeEvent } from './events';
import {
  parsePending,
  parseSettings,
  passesSettings,
  QUIET_DELAY_MS,
  requestSettingsChange,
  settleSettings,
  SETTINGS_DEFAULTS,
  type NotificationSettings,
} from './settings';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const active: NotificationSettings = structuredClone(SETTINGS_DEFAULTS) as NotificationSettings;
const ev = (kind: Parameters<typeof makeEvent>[0]['kind'], level?: 50 | 80 | 100) =>
  makeEvent({ kind, dedupeKey: 'k', occurredAt: 't', level: level ?? null });

describe('defaults', () => {
  it('every category on, minimum severity info', () => {
    expect(SETTINGS_DEFAULTS).toEqual({
      categories: { risk: true, security: true, analyst: true, system: true },
      minSeverity: 'info',
    });
  });
});

describe('quieter changes wait 24 hours, louder ones apply now', () => {
  it('switching a category OFF is deferred and leaves it on for now', () => {
    const r = requestSettingsChange(
      active,
      { categories: {} },
      { categories: { analyst: false } },
      NOW,
    );
    expect(r.active.categories.analyst).toBe(true);
    expect(r.deferred).toEqual([
      {
        what: 'category analyst off',
        effectiveAt: new Date(NOW.getTime() + QUIET_DELAY_MS).toISOString(),
      },
    ]);
  });
  it('raising the minimum severity is deferred; lowering it applies now', () => {
    const r = requestSettingsChange(active, { categories: {} }, { minSeverity: 'warning' }, NOW);
    expect(r.active.minSeverity).toBe('info');
    expect(r.deferred).toHaveLength(1);
    const high: NotificationSettings = { ...active, minSeverity: 'critical' };
    const l = requestSettingsChange(high, { categories: {} }, { minSeverity: 'warning' }, NOW);
    expect(l.active.minSeverity).toBe('warning');
    expect(l.applied).toEqual(['minimum severity warning']);
  });
  it('switching a category back ON applies now and cancels a waiting OFF', () => {
    const off = requestSettingsChange(
      active,
      { categories: {} },
      { categories: { risk: false } },
      NOW,
    );
    const back = requestSettingsChange(active, off.pending, { categories: { risk: true } }, NOW);
    expect(back.cancelled).toEqual(['category risk']);
    expect(back.pending.categories).toEqual({});
  });
  it('asking again for the same quieter value keeps the original timer', () => {
    const first = requestSettingsChange(
      active,
      { categories: {} },
      { categories: { risk: false } },
      NOW,
    );
    const later = new Date(NOW.getTime() + 3_600_000);
    const again = requestSettingsChange(
      active,
      first.pending,
      { categories: { risk: false } },
      later,
    );
    expect(again.deferred[0]?.effectiveAt).toBe(first.deferred[0]?.effectiveAt);
  });
  it('a waiting severity raise is cancelled by asking for the current value', () => {
    const first = requestSettingsChange(
      active,
      { categories: {} },
      { minSeverity: 'critical' },
      NOW,
    );
    const back = requestSettingsChange(active, first.pending, { minSeverity: 'info' }, NOW);
    expect(back.cancelled).toEqual(['minimum severity']);
    expect(back.pending.minSeverity).toBeUndefined();
  });
  it('unchanged values are reported as unchanged', () => {
    const r = requestSettingsChange(
      active,
      { categories: {} },
      { categories: { risk: true }, minSeverity: 'info' },
      NOW,
    );
    expect(r.unchanged).toEqual(['category risk', 'minimum severity']);
  });
  it('rejects unknown categories and severities', () => {
    expect(() =>
      requestSettingsChange(
        active,
        { categories: {} },
        { categories: { nope: false } as never },
        NOW,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      requestSettingsChange(active, { categories: {} }, { minSeverity: 'loud' }, NOW),
    ).toThrow(ValidationError);
  });
  it('does not mutate its inputs', () => {
    const a = structuredClone(active);
    requestSettingsChange(
      a,
      { categories: {} },
      { categories: { risk: false }, minSeverity: 'critical' },
      NOW,
    );
    expect(a).toEqual(active);
  });
});

describe('settleSettings', () => {
  it('applies a quieter change exactly at its time, not before', () => {
    const r = requestSettingsChange(
      active,
      { categories: {} },
      { categories: { risk: false } },
      NOW,
    );
    const at = new Date(NOW.getTime() + QUIET_DELAY_MS);
    expect(
      settleSettings(active, r.pending, new Date(at.getTime() - 1)).settings.categories.risk,
    ).toBe(true);
    const done = settleSettings(active, r.pending, at);
    expect(done.settings.categories.risk).toBe(false);
    expect(done.becameEffective).toEqual(['category risk off']);
    expect(done.stillPending.categories).toEqual({});
  });
});

describe('parsing stored values (fail closed)', () => {
  it('accepts the defaults and rejects junk', () => {
    expect(parseSettings(JSON.stringify(SETTINGS_DEFAULTS.categories), 'info').ok).toBe(true);
    expect(parseSettings('{"risk":true}', 'info').ok).toBe(false);
    expect(parseSettings('nope', 'info').ok).toBe(false);
    expect(parseSettings(JSON.stringify(SETTINGS_DEFAULTS.categories), 'loud').ok).toBe(false);
  });
  it('pending: empty is fine, junk is not', () => {
    expect(parsePending('{}').ok).toBe(true);
    expect(parsePending(null).ok).toBe(true);
    expect(parsePending('{"categories":{"risk":{"value":"x"}}}').ok).toBe(false);
    expect(
      parsePending(
        '{"categories":{"risk":{"value":false,"requestedAt":"a","effectiveAt":"never"}}}',
      ).ok,
    ).toBe(false);
    expect(parsePending('[]').ok).toBe(false);
  });
});

describe('passesSettings', () => {
  it('follows the category switches and the minimum severity', () => {
    const s: NotificationSettings = {
      categories: { ...active.categories, analyst: false },
      minSeverity: 'warning',
    };
    expect(passesSettings(ev('analyst_call_failed'), s)).toBe(false);
    expect(passesSettings(ev('login_success'), s)).toBe(false); // info < warning
    expect(passesSettings(ev('password_changed'), s)).toBe(true);
  });
  it('CRITICAL events can never be switched off', () => {
    const off: NotificationSettings = {
      categories: { risk: false, security: false, analyst: false, system: false },
      minSeverity: 'critical',
    };
    expect(passesSettings(ev('halt_started_daily_loss'), off)).toBe(true);
    expect(passesSettings(ev('recovery_code_used'), off)).toBe(true);
    expect(passesSettings(ev('daily_loss_usage', 100), off)).toBe(true);
    expect(passesSettings(ev('daily_loss_usage', 80), off)).toBe(false);
  });
  it('the test message, the summary and the final notice ignore the category and severity settings', () => {
    const off: NotificationSettings = {
      categories: { risk: false, security: false, analyst: false, system: false },
      minSeverity: 'critical',
    };
    for (const k of ['test_message', 'flood_summary', 'notifications_switched_off'] as const) {
      expect(passesSettings(ev(k), off)).toBe(true);
    }
  });
});

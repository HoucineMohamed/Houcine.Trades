import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import {
  HARD_CEILINGS,
  isTighter,
  LOOSEN_DELAY_MS,
  parsePendingJson,
  parseRiskSettings,
  parseSettingsJson,
  requestSettingsChange,
  RISK_DEFAULTS,
  settleSettings,
  type RiskSettings,
} from './settings';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const PLUS_24H = '2026-03-11T12:00:00.000Z';
const defaults = (): RiskSettings => ({ ...RISK_DEFAULTS });

describe('defaults and hard ceilings', () => {
  it('the defaults are the ones you specified, and they are valid', () => {
    expect(RISK_DEFAULTS).toEqual({
      maxRiskPerTradePercent: '1',
      maxDailyLossPercent: '3',
      maxOpenRiskPercent: '3',
      maxOpenTrades: 3,
      maxDrawdownPercent: '10',
      minRewardToRisk: '1.5',
    });
    expect(parseRiskSettings(RISK_DEFAULTS)).toEqual({ ok: true, settings: RISK_DEFAULTS });
  });

  it('the ceilings are 2 %, 5 %, 6 trades, 20 %', () => {
    expect(HARD_CEILINGS).toMatchObject({
      maxRiskPerTradePercent: '2',
      maxDailyLossPercent: '5',
      maxOpenTrades: 6,
      maxDrawdownPercent: '20',
    });
  });

  it.each([
    ['maxRiskPerTradePercent', '2', '2.0000000001'],
    ['maxDailyLossPercent', '5', '5.01'],
    ['maxOpenRiskPercent', '6', '6.01'],
    ['maxDrawdownPercent', '20', '20.01'],
    ['minRewardToRisk', '100', '100.01'],
  ] as const)(
    '%s: exactly the ceiling %s is accepted, %s is rejected',
    (field, atCeiling, over) => {
      expect(parseRiskSettings({ ...RISK_DEFAULTS, [field]: atCeiling }).ok).toBe(true);
      const bad = parseRiskSettings({ ...RISK_DEFAULTS, [field]: over });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.problem).toMatch(/ceiling|above/);
    },
  );

  it('max open trades: 6 is accepted, 7 rejected; 0, 2.5 and "3" rejected', () => {
    expect(parseRiskSettings({ ...RISK_DEFAULTS, maxOpenTrades: 6 }).ok).toBe(true);
    for (const bad of [7, 0, -1, 2.5, '3', null]) {
      expect(parseRiskSettings({ ...RISK_DEFAULTS, maxOpenTrades: bad }).ok).toBe(false);
    }
  });

  it.each(['0', '-1', '', 'abc', '1e1', null])('rejects percent %j', (bad) => {
    expect(parseRiskSettings({ ...RISK_DEFAULTS, maxRiskPerTradePercent: bad }).ok).toBe(false);
  });

  it('rejects unknown or missing settings (strict)', () => {
    expect(parseRiskSettings({ ...RISK_DEFAULTS, bonus: '1' }).ok).toBe(false);
    const { minRewardToRisk, ...missing } = RISK_DEFAULTS;
    void minRewardToRisk;
    expect(parseRiskSettings(missing).ok).toBe(false);
    expect(parseRiskSettings(null).ok).toBe(false);
  });

  it('corrupt stored text fails closed with a reason', () => {
    expect(parseSettingsJson(null)).toEqual({ ok: false, problem: 'no risk settings are stored' });
    expect(parseSettingsJson('{not json')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/not readable/),
    });
    expect(
      parseSettingsJson(JSON.stringify({ ...RISK_DEFAULTS, maxRiskPerTradePercent: '50' })),
    ).toMatchObject({ ok: false });
    expect(parseSettingsJson(JSON.stringify(RISK_DEFAULTS))).toMatchObject({ ok: true });
  });
});

describe('which direction is tighter', () => {
  it('lower is tighter, except minimum reward-to-risk where higher is tighter', () => {
    expect(isTighter('maxRiskPerTradePercent', '0.5', '1')).toBe(true);
    expect(isTighter('maxRiskPerTradePercent', '1.5', '1')).toBe(false);
    expect(isTighter('maxOpenTrades', 2, 3)).toBe(true);
    expect(isTighter('maxOpenTrades', 4, 3)).toBe(false);
    expect(isTighter('maxDrawdownPercent', '5', '10')).toBe(true);
    expect(isTighter('minRewardToRisk', '2', '1.5')).toBe(true);
    expect(isTighter('minRewardToRisk', '1', '1.5')).toBe(false);
    expect(isTighter('maxDailyLossPercent', '3', '3')).toBe(false); // equal is not tighter
  });
});

describe('tightening is immediate, loosening is delayed 24 hours', () => {
  it('tightening applies right away', () => {
    const r = requestSettingsChange(
      defaults(),
      {},
      { maxRiskPerTradePercent: '0.5', maxOpenTrades: 2, minRewardToRisk: '2' },
      NOW,
    );
    expect(r.active).toMatchObject({
      maxRiskPerTradePercent: '0.5',
      maxOpenTrades: 2,
      minRewardToRisk: '2',
    });
    expect(r.pending).toEqual({});
    expect(r.applied.map((a) => a.field)).toEqual([
      'maxRiskPerTradePercent',
      'maxOpenTrades',
      'minRewardToRisk',
    ]);
  });

  it('loosening is stored as pending and the active value does NOT change', () => {
    const r = requestSettingsChange(
      defaults(),
      {},
      { maxRiskPerTradePercent: '1.5', minRewardToRisk: '1', maxOpenTrades: 4 },
      NOW,
    );
    expect(r.active).toEqual(defaults());
    expect(r.pending.maxRiskPerTradePercent).toEqual({
      value: '1.5',
      requestedAt: NOW.toISOString(),
      effectiveAt: PLUS_24H,
    });
    expect(r.pending.minRewardToRisk).toMatchObject({ value: '1', effectiveAt: PLUS_24H });
    expect(r.pending.maxOpenTrades).toMatchObject({ value: 4, effectiveAt: PLUS_24H });
    expect(r.deferred.map((d) => d.field).sort()).toEqual([
      'maxOpenTrades',
      'maxRiskPerTradePercent',
      'minRewardToRisk',
    ]);
    expect(LOOSEN_DELAY_MS).toBe(24 * 3600 * 1000);
  });

  it('a mixed request applies the tightening now and delays the loosening', () => {
    const r = requestSettingsChange(
      defaults(),
      {},
      { maxRiskPerTradePercent: '0.5', maxDailyLossPercent: '4' },
      NOW,
    );
    expect(r.active.maxRiskPerTradePercent).toBe('0.5');
    expect(r.active.maxDailyLossPercent).toBe('3');
    expect(r.pending.maxDailyLossPercent).toMatchObject({ value: '4' });
  });

  it('values above a hard ceiling are rejected and every problem is listed', () => {
    try {
      requestSettingsChange(
        defaults(),
        {},
        { maxRiskPerTradePercent: '3', maxOpenTrades: 9, maxDailyLossPercent: '2' },
        NOW,
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).issues.map((i) => i.field).sort()).toEqual([
        'maxOpenTrades',
        'maxRiskPerTradePercent',
      ]);
    }
  });

  it('nothing is changed when any value is rejected (all or nothing)', () => {
    const active = defaults();
    expect(() =>
      requestSettingsChange(
        active,
        {},
        { maxRiskPerTradePercent: '0.5', maxDrawdownPercent: '30' },
        NOW,
      ),
    ).toThrow(ValidationError);
    expect(active).toEqual(defaults());
  });

  it('rejects an unknown setting name', () => {
    expect(() => requestSettingsChange(defaults(), {}, { bogus: '1' } as never, NOW)).toThrow(
      /not a risk setting/,
    );
  });

  it('the same value is unchanged', () => {
    const r = requestSettingsChange(defaults(), {}, { maxRiskPerTradePercent: '1.0' }, NOW);
    expect(r.unchanged).toEqual(['maxRiskPerTradePercent']);
  });

  it('a tighter value cancels a pending loosening for that field', () => {
    const first = requestSettingsChange(defaults(), {}, { maxRiskPerTradePercent: '1.5' }, NOW);
    const second = requestSettingsChange(
      first.active,
      first.pending,
      { maxRiskPerTradePercent: '0.8' },
      NOW,
    );
    expect(second.active.maxRiskPerTradePercent).toBe('0.8');
    expect(second.pending).toEqual({});
    expect(second.cancelled).toEqual(['maxRiskPerTradePercent']);
  });

  it('asking for the current value again cancels the pending loosening', () => {
    const first = requestSettingsChange(defaults(), {}, { maxRiskPerTradePercent: '1.5' }, NOW);
    const second = requestSettingsChange(
      first.active,
      first.pending,
      { maxRiskPerTradePercent: '1' },
      NOW,
    );
    expect(second.pending).toEqual({});
    expect(second.cancelled).toEqual(['maxRiskPerTradePercent']);
  });

  it('the same looser value again keeps the ORIGINAL timer; a different looser value restarts it', () => {
    const first = requestSettingsChange(defaults(), {}, { maxRiskPerTradePercent: '1.5' }, NOW);
    const later = new Date(NOW.getTime() + 3600_000);
    const same = requestSettingsChange(
      first.active,
      first.pending,
      { maxRiskPerTradePercent: '1.50' },
      later,
    );
    expect(same.pending.maxRiskPerTradePercent!.effectiveAt).toBe(PLUS_24H);
    const different = requestSettingsChange(
      first.active,
      first.pending,
      { maxRiskPerTradePercent: '1.8' },
      later,
    );
    expect(different.pending.maxRiskPerTradePercent).toMatchObject({
      value: '1.8',
      effectiveAt: '2026-03-11T13:00:00.000Z',
    });
  });
});

describe('pending changes become effective at their time (before / exactly at / after)', () => {
  const requested = requestSettingsChange(defaults(), {}, { maxRiskPerTradePercent: '1.5' }, NOW);
  const at = (ms: number) =>
    settleSettings(
      requested.active,
      requested.pending,
      new Date(new Date(PLUS_24H).getTime() + ms),
    );

  it('1 ms before: not effective', () => {
    const s = at(-1);
    expect(s.settings.maxRiskPerTradePercent).toBe('1');
    expect(s.stillPending.maxRiskPerTradePercent).toBeDefined();
    expect(s.becameEffective).toEqual([]);
  });

  it('exactly at the effective time: effective', () => {
    const s = at(0);
    expect(s.settings.maxRiskPerTradePercent).toBe('1.5');
    expect(s.stillPending).toEqual({});
    expect(s.becameEffective).toEqual([{ field: 'maxRiskPerTradePercent', from: '1', to: '1.5' }]);
  });

  it('after: effective', () => {
    expect(at(60_000).settings.maxRiskPerTradePercent).toBe('1.5');
  });
});

describe('stored pending changes', () => {
  it('empty or missing means none', () => {
    expect(parsePendingJson(null)).toEqual({ ok: true, pending: {} });
    expect(parsePendingJson('{}')).toEqual({ ok: true, pending: {} });
  });

  it('round trips', () => {
    const r = requestSettingsChange(defaults(), {}, { maxOpenTrades: 4 }, NOW);
    expect(parsePendingJson(JSON.stringify(r.pending))).toEqual({ ok: true, pending: r.pending });
  });

  it('corrupt pending data fails closed', () => {
    expect(parsePendingJson('{oops').ok).toBe(false);
    expect(parsePendingJson('[]').ok).toBe(false);
    expect(
      parsePendingJson(
        JSON.stringify({ bogus: { value: '1', requestedAt: 'a', effectiveAt: PLUS_24H } }),
      ).ok,
    ).toBe(false);
    expect(
      parsePendingJson(
        JSON.stringify({
          maxRiskPerTradePercent: { value: '9', requestedAt: 'a', effectiveAt: PLUS_24H },
        }),
      ).ok,
    ).toBe(false); // above ceiling
    expect(
      parsePendingJson(
        JSON.stringify({
          maxRiskPerTradePercent: { value: '1.5', requestedAt: 'a', effectiveAt: 'never' },
        }),
      ).ok,
    ).toBe(false);
  });
});

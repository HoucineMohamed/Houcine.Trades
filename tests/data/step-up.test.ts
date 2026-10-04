import { describe, expect, it } from 'vitest';
import { logTrade } from '@/data/journal';
import {
  evaluatePlanForAccount,
  getRiskSettingsView,
  haltManually,
  resetHalt,
  restoreDefaultRiskSettings,
  syncRiskState,
  updateRiskSettings,
} from '@/data/risk';
import { listRiskEvents } from '@/data/risk-events';
import { listTrades } from '@/data/trades';
import {
  assertFreshAuth,
  issueFreshAuth,
  StepUpRequiredError,
  STEP_UP_WINDOW_MS,
  type FreshAuth,
} from '@/domain/auth/stepup';
import { at, riskDb } from '../helpers/risk';

const NOW = at('2026-03-10T12:00:00.000Z');
const fresh = (verifiedAt: Date = NOW) => issueFreshAuth(1, verifiedAt);
const stale = fresh(new Date(NOW.getTime() - STEP_UP_WINDOW_MS)); // exactly 5 minutes old
const forged = { sessionId: 1, verifiedAt: NOW.toISOString() } as unknown as FreshAuth;
const RESET = { confirm: 'RESET', reason: 'rested and reviewed my plan' };
const OVERRIDE = { confirm: 'OVERRIDE', reason: 'I already took this trade on the exchange' };
const kinds = (db: ReturnType<typeof riskDb>) => listRiskEvents(db, 1, 100).map((e) => e.kind);

// Each sensitive action must refuse: no proof, a stale proof, and a hand-made look-alike.
const BAD_PROOFS: [string, FreshAuth | null | undefined][] = [
  ['no proof', null],
  ['an undefined proof', undefined],
  ['a proof exactly 5 minutes old', stale],
  ['a forged look-alike object', forged],
];

describe('the proof itself', () => {
  it('is fresh strictly inside 5 minutes and not at exactly 5', () => {
    const justInside = fresh(new Date(NOW.getTime() - STEP_UP_WINDOW_MS + 1));
    expect(assertFreshAuth(justInside, NOW, 'x')).toBe(justInside);
    expect(() => assertFreshAuth(stale, NOW, 'x')).toThrow(StepUpRequiredError);
  });
  it('cannot come from the future either', () => {
    expect(() => assertFreshAuth(fresh(new Date(NOW.getTime() + 1000)), NOW, 'x')).toThrow(
      StepUpRequiredError,
    );
  });
});

describe('resetting a halt needs a fresh code', () => {
  for (const [name, proof] of BAD_PROOFS) {
    it(`refuses ${name} and the halt stays`, () => {
      const db = riskDb();
      haltManually(db, 1, 'cooling off', NOW);
      const before = kinds(db);
      expect(() => resetHalt(db, 1, 'manual', RESET, proof as FreshAuth, NOW)).toThrow(
        StepUpRequiredError,
      );
      expect(kinds(db)).toEqual(before);
      expect(syncRiskState(db, 1, NOW).halts.map((h) => h.kind)).toEqual(['manual']);
    });
  }
  it('works with a fresh proof', () => {
    const db = riskDb();
    haltManually(db, 1, 'cooling off', NOW);
    resetHalt(db, 1, 'manual', RESET, fresh(), NOW);
    expect(syncRiskState(db, 1, NOW).halts).toEqual([]);
  });
});

describe('the kill switch needs no code (stopping is always one click)', () => {
  it('starts a manual halt without any proof', () => {
    const db = riskDb();
    haltManually(db, 1, 'something feels wrong', NOW);
    expect(syncRiskState(db, 1, NOW).halts.map((h) => h.kind)).toEqual(['manual']);
  });
});

describe('restoring the default risk settings needs a fresh code', () => {
  for (const [name, proof] of BAD_PROOFS) {
    it(`refuses ${name}`, () => {
      const db = riskDb();
      const before = kinds(db);
      expect(() => restoreDefaultRiskSettings(db, 1, RESET, proof as FreshAuth, NOW)).toThrow(
        StepUpRequiredError,
      );
      expect(kinds(db)).toEqual(before);
    });
  }
  it('works with a fresh proof', () => {
    const db = riskDb();
    restoreDefaultRiskSettings(db, 1, RESET, fresh(), NOW);
    expect(kinds(db)).toContain('settings_change');
  });
});

describe('loosening a limit needs a fresh code; tightening does not', () => {
  it('tightening works without any proof', () => {
    const db = riskDb();
    const r = updateRiskSettings(db, 1, { maxRiskPerTradePercent: '0.5' }, null, NOW);
    expect(r.applied).toHaveLength(1);
  });
  for (const [name, proof] of BAD_PROOFS) {
    it(`loosening is refused with ${name}, and nothing is written`, () => {
      const db = riskDb();
      const before = kinds(db);
      const view = getRiskSettingsView(db, 1, NOW);
      expect(() =>
        updateRiskSettings(db, 1, { maxOpenTrades: 6 }, proof as FreshAuth, NOW),
      ).toThrow(StepUpRequiredError);
      expect(kinds(db)).toEqual(before);
      expect(getRiskSettingsView(db, 1, NOW).pending).toEqual(view.pending);
    });
  }
  it('a mixed change (one tighter, one looser) is refused as a whole without a proof', () => {
    const db = riskDb();
    const view = getRiskSettingsView(db, 1, NOW);
    expect(() =>
      updateRiskSettings(db, 1, { maxRiskPerTradePercent: '0.5', maxOpenTrades: 6 }, null, NOW),
    ).toThrow(StepUpRequiredError);
    expect(getRiskSettingsView(db, 1, NOW).active).toEqual(view.active); // the tighter half was NOT applied
  });
  it('loosening is queued (24 hours) with a fresh proof', () => {
    const db = riskDb();
    const r = updateRiskSettings(db, 1, { maxOpenTrades: 6 }, fresh(), NOW);
    expect(r.deferred).toHaveLength(1);
  });
});

describe('logging an override needs a fresh code; an approved plan does not', () => {
  const input = (size: string) => ({
    accountId: 1,
    symbol: 'BTCUSDT',
    assetClass: 'crypto',
    direction: 'long',
    plannedEntry: '100',
    stopLoss: '95',
    takeProfit: '115',
    size,
    quoteCurrency: 'USDT',
  });
  it('an approved plan needs no proof', () => {
    const db = riskDb();
    logTrade(db, input('20'), { now: () => NOW });
    expect(listTrades(db)).toHaveLength(1);
  });
  for (const [name, proof] of BAD_PROOFS) {
    it(`an override with ${name} is refused: no trade, no override event`, () => {
      const db = riskDb();
      expect(() =>
        logTrade(db, input('30'), { now: () => NOW, override: OVERRIDE, auth: proof }),
      ).toThrow(StepUpRequiredError);
      expect(listTrades(db)).toHaveLength(0);
      expect(kinds(db)).not.toContain('override');
    });
  }
  it('an override with a fresh proof is logged', () => {
    const db = riskDb();
    const r = logTrade(db, input('30'), { now: () => NOW, override: OVERRIDE, auth: fresh() });
    expect(r.overridden).toBe(true);
  });
  it('the risk engine verdict is untouched by any proof', () => {
    const db = riskDb();
    expect(
      evaluatePlanForAccount(
        db,
        1,
        {
          symbol: 'BTCUSDT',
          direction: 'long',
          entry: '100',
          stop: '95',
          target: '115',
          size: '30',
          quoteCurrency: 'USDT',
        },
        NOW,
      ).verdict.approved,
    ).toBe(false);
  });
});

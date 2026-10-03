import { describe, expect, it } from 'vitest';
import {
  closeTradeAndSync,
  getTradeRiskFlags,
  listVerdicts,
  logTrade,
  openTradeChecked,
  RiskRefusalError,
} from '@/data/journal';
import { haltManually, syncRiskState } from '@/data/risk';
import { listRiskEvents } from '@/data/risk-events';
import { getTrade, listTrades } from '@/data/trades';
import { ValidationError } from '@/domain/errors';
import { at, closedTrade, riskDb } from '../helpers/risk';

const NOW = at('2026-03-10T12:00:00.000Z');
const OVERRIDE = { confirm: 'OVERRIDE', reason: 'I already took this trade on the exchange' };

// long BTCUSDT entry 100, stop 95 -> risk = 5 x size. Equity 10000: 1 % limit = 100 -> size 20 is exactly at the limit.
const input = (over: Record<string, unknown> = {}) => ({
  accountId: 1,
  symbol: 'BTCUSDT',
  assetClass: 'crypto',
  direction: 'long',
  plannedEntry: '100',
  stopLoss: '95',
  takeProfit: '115',
  size: '20',
  quoteCurrency: 'USDT',
  ...over,
});
const OPEN = { entryPrice: '100', openedAt: '2026-03-10T11:00:00Z' };
const eventKinds = (db: ReturnType<typeof riskDb>) =>
  listRiskEvents(db, 1, 100)
    .map((e) => e.kind)
    .reverse();
const tradeCount = (db: ReturnType<typeof riskDb>) => listTrades(db).length;

describe('an approved plan is logged with its verdict', () => {
  it('saves the trade and a verdict snapshot; no override, no refusal', () => {
    const db = riskDb();
    const r = logTrade(db, input(), { now: () => NOW });
    expect(r.overridden).toBe(false);
    expect(r.verdict.approved).toBe(true);
    expect(r.trade.status).toBe('planned');
    const verdicts = listVerdicts(db, r.trade.id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      stage: 'created',
      approved: 1,
      overrideReason: null,
      violationCodes: '[]',
      createdAt: NOW.toISOString(),
    });
    expect(JSON.parse(verdicts[0]!.snapshotJson)).toMatchObject({
      approved: true,
      numbers: { riskAmount: '100', riskPercent: '1.0000' },
    });
    expect(eventKinds(db)).toEqual(['settings_change']); // only the creation of the settings
    expect(getTradeRiskFlags(db).get(r.trade.id)?.overridden).toBe(false);
  });

  it('a trade logged already open is judged on its real entry price', () => {
    const db = riskDb();
    const r = logTrade(
      db,
      input({
        status: 'open',
        entryPrice: '101',
        openedAt: '2026-03-10T11:00:00Z',
        stopLoss: '96',
      }),
      { now: () => NOW },
    );
    expect(r.trade.status).toBe('open');
    expect(r.verdict.numbers.riskAmount).toBe('100'); // |101 - 96| x 20
  });
});

describe('a refused plan is not saved, and the refusal is logged', () => {
  it('too much risk: nothing is saved but a plan_refused event', () => {
    const db = riskDb();
    expect(() =>
      logTrade(db, input({ size: '20.000000000000000001' }), { now: () => NOW }),
    ).toThrow(RiskRefusalError);
    expect(tradeCount(db)).toBe(0);
    expect(eventKinds(db)).toEqual(['settings_change', 'plan_refused']);
    const e = listRiskEvents(db, 1, 1)[0]!;
    expect(e.reason).toBe('MAX_RISK_PER_TRADE');
    expect(JSON.parse(e.detailsJson).codes).toEqual(['MAX_RISK_PER_TRADE']);
  });

  it('the error lists every violation in plain words and says how to override', () => {
    const db = riskDb();
    haltManually(db, 1, 'cooling off', NOW);
    try {
      logTrade(db, input({ size: '30', quoteCurrency: 'EUR' }), { now: () => NOW });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RiskRefusalError);
      const err = e as RiskRefusalError;
      expect(err.verdict.violations.map((v) => v.code).sort()).toEqual([
        'CURRENCY_MISMATCH',
        'HALTED_MANUAL',
      ]);
      expect(err.message).toContain('risk cannot be verified without currency conversion');
      expect(err.message).toContain('OVERRIDE');
    }
  });

  it('a missing stop-loss never reaches the risk engine: the domain rejects it first (rule 4)', () => {
    const db = riskDb();
    expect(() => logTrade(db, input({ stopLoss: undefined }), { now: () => NOW })).toThrow(
      ValidationError,
    );
    expect(tradeCount(db)).toBe(0);
  });
});

describe('override: a refused plan can be LOGGED with a typed reason, and is clearly flagged', () => {
  const tooBig = () => input({ size: '30' }); // risk 150 = 1.5 % > 1 %

  it('needs the exact word OVERRIDE and a reason of at least 10 characters', () => {
    const db = riskDb();
    for (const override of [
      { confirm: 'override', reason: 'a good long reason' },
      { confirm: 'OVERRIDE', reason: 'short' },
      { confirm: 'OVERRIDE' },
      { reason: 'a good long reason here' },
    ]) {
      expect(() => logTrade(db, tooBig(), { now: () => NOW, override })).toThrow(ValidationError);
    }
    expect(tradeCount(db)).toBe(0);
  });

  it('with a valid override the trade is saved, the verdict says refused + the reason, and an override event is logged', () => {
    const db = riskDb();
    const r = logTrade(db, tooBig(), { now: () => NOW, override: OVERRIDE });
    expect(r.overridden).toBe(true);
    expect(r.verdict.approved).toBe(false);
    expect(getTrade(db, r.trade.id)?.status).toBe('planned');

    const v = listVerdicts(db, r.trade.id)[0]!;
    expect(v).toMatchObject({
      stage: 'created',
      approved: 0,
      overrideReason: OVERRIDE.reason,
      violationCodes: '["MAX_RISK_PER_TRADE"]',
    });
    const e = listRiskEvents(db, 1, 1)[0]!;
    expect(e).toMatchObject({ kind: 'override', tradeId: r.trade.id, reason: OVERRIDE.reason });
    expect(JSON.parse(e.detailsJson)).toMatchObject({
      stage: 'created',
      codes: ['MAX_RISK_PER_TRADE'],
    });

    const flags = getTradeRiskFlags(db).get(r.trade.id)!;
    expect(flags).toMatchObject({
      overridden: true,
      overrideReasons: [OVERRIDE.reason],
      violationCodes: ['MAX_RISK_PER_TRADE'],
    });
  });

  it('works while trading is halted (you may log a trade you already took) and is flagged', () => {
    const db = riskDb();
    haltManually(db, 1, 'cooling off', NOW);
    const r = logTrade(db, input(), { now: () => NOW, override: OVERRIDE });
    expect(r.overridden).toBe(true);
    expect(getTradeRiskFlags(db).get(r.trade.id)?.violationCodes).toEqual(['HALTED_MANUAL']);
  });

  it('an override can never rescue bad data: an unknown account is still an error', () => {
    const db = riskDb();
    expect(() =>
      logTrade(db, input({ accountId: 99 }), { now: () => NOW, override: OVERRIDE }),
    ).toThrow(/Account not found/);
    expect(tradeCount(db)).toBe(0);
  });

  it('is all-or-nothing: if saving fails after the check, no verdict or override event remains', () => {
    const db = riskDb();
    const before = eventKinds(db).length;
    expect(() =>
      logTrade(db, input({ size: '30', setupId: 999 }), { now: () => NOW, override: OVERRIDE }),
    ).toThrow(/Setup not found/);
    expect(tradeCount(db)).toBe(0);
    expect(eventKinds(db)).toHaveLength(before);
    expect(
      (db.$client.prepare('SELECT count(*) c FROM risk_verdicts').get() as { c: number }).c,
    ).toBe(0);
  });
});

describe('opening a planned trade goes through the risk engine again', () => {
  function fullAccount() {
    const db = riskDb();
    // three small open trades (risk 5 each)
    for (let i = 0; i < 3; i++)
      logTrade(
        db,
        input({ size: '1', status: 'open', entryPrice: '100', openedAt: '2026-03-10T10:00:00Z' }),
        { now: () => NOW },
      );
    return db;
  }

  it('approved at creation and approved at opening: two verdict snapshots', () => {
    const db = riskDb();
    const planned = logTrade(db, input(), { now: () => NOW }).trade;
    const opened = openTradeChecked(db, planned.id, OPEN, {
      now: () => at('2026-03-10T12:30:00.000Z'),
    });
    expect(opened.trade).toMatchObject({
      status: 'open',
      entryPrice: '100',
      initialStopLoss: '95',
    });
    expect(listVerdicts(db, planned.id).map((v) => [v.stage, v.approved])).toEqual([
      ['created', 1],
      ['opened', 1],
    ]);
  });

  it('refused at opening when the situation changed (a 4th open trade): not opened, refusal logged', () => {
    const db = riskDb();
    const planned = logTrade(db, input({ size: '1' }), { now: () => NOW }).trade; // planned, small
    for (let i = 0; i < 3; i++)
      logTrade(
        db,
        input({ size: '1', status: 'open', entryPrice: '100', openedAt: '2026-03-10T10:00:00Z' }),
        { now: () => NOW },
      );
    expect(() => openTradeChecked(db, planned.id, OPEN, { now: () => NOW })).toThrow(/limit of 3/);
    expect(getTrade(db, planned.id)?.status).toBe('planned');
    expect(listRiskEvents(db, 1, 1)[0]).toMatchObject({ kind: 'plan_refused' });
    expect(JSON.parse(listRiskEvents(db, 1, 1)[0]!.detailsJson).stage).toBe('opened');
  });

  it('with an override it opens, and the opened verdict carries the reason', () => {
    const db = fullAccount();
    const planned = logTrade(db, input({ size: '1' }), {
      now: () => NOW,
      override: OVERRIDE,
    }).trade; // 4th trade: needs override already? it is only planned
    // (a planned trade counts as a plan that would open now, so even creating it needed the override)
    const r = openTradeChecked(db, planned.id, OPEN, { now: () => NOW, override: OVERRIDE });
    expect(r.overridden).toBe(true);
    expect(getTrade(db, planned.id)?.status).toBe('open');
    const stages = listVerdicts(db, planned.id).map((v) => [
      v.stage,
      v.approved,
      v.overrideReason !== null,
    ]);
    expect(stages).toEqual([
      ['created', 0, true],
      ['opened', 0, true],
    ]);
    expect(getTradeRiskFlags(db).get(planned.id)?.overridden).toBe(true);
  });

  it('opening a trade that is not planned is an error, and a missing trade is not found', () => {
    const db = riskDb();
    const planned = logTrade(db, input(), { now: () => NOW }).trade;
    openTradeChecked(db, planned.id, OPEN, { now: () => NOW });
    expect(() => openTradeChecked(db, planned.id, OPEN, { now: () => NOW })).toThrow(
      /open trade cannot become open/,
    );
    expect(() => openTradeChecked(db, 999, OPEN, { now: () => NOW })).toThrow(/was not found/);
  });

  it('the real entry price is judged against the stop-loss', () => {
    const db = riskDb();
    const planned = logTrade(db, input(), { now: () => NOW }).trade;
    expect(() =>
      openTradeChecked(
        db,
        planned.id,
        { entryPrice: '94', openedAt: '2026-03-10T11:00:00Z' },
        { now: () => NOW },
      ),
    ).toThrow(ValidationError);
  });
});

describe('closing is never blocked, and it latches a halt it causes', () => {
  it('closes even while halted, and a drawdown caused by the close is logged at once', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 2000, closedAt: '2026-03-01T10:00:00.000Z' }); // peak 12000
    // an open trade that will lose 1200 (10 % of the peak)
    const big = logTrade(
      db,
      input({
        plannedEntry: '100000',
        stopLoss: '90000',
        size: '1',
        takeProfit: null,
        status: 'open',
        entryPrice: '100000',
        openedAt: '2026-03-02T00:00:00Z',
      }),
      { now: () => at('2026-03-02T00:00:00.000Z'), override: OVERRIDE },
    ).trade;
    haltManually(db, 1, 'being careful', at('2026-03-02T08:00:00.000Z'));
    const closed = closeTradeAndSync(
      db,
      big.id,
      { exitPrice: '98800', closedAt: '2026-03-02T09:00:00.000Z' },
      { now: () => at('2026-03-02T09:00:00.000Z') },
    );
    expect(closed.status).toBe('closed');
    expect(listRiskEvents(db, 1, 5).map((e) => `${e.kind}:${e.haltKind}`)).toContain(
      'halt:drawdown',
    );
  });

  it('syncing again later does not duplicate the latch', () => {
    const db = riskDb();
    closedTrade(db, { pnl: 2000, closedAt: '2026-03-01T10:00:00.000Z' });
    closedTrade(db, { pnl: -1200, closedAt: '2026-03-02T09:00:00.000Z' });
    syncRiskState(db, 1, at('2026-03-03T00:00:00.000Z'));
    syncRiskState(db, 1, at('2026-03-04T00:00:00.000Z'));
    expect(
      listRiskEvents(db, 1, 20).filter((e) => e.kind === 'halt' && e.haltKind === 'drawdown'),
    ).toHaveLength(1);
  });
});

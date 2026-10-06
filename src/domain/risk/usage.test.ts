import { describe, expect, it } from 'vitest';
import { ctx, openTrade, withSettings } from './fixtures';
import { computeRiskUsage } from './usage';

// Default limits: 3 % daily loss, 3 % open risk, 3 open trades, 10 % drawdown. Equity 10000.

describe('daily loss usage', () => {
  it('hand-worked: a loss of 150 on 10000 is 1.50 % of equity and 50.00 % of the 300 limit', () => {
    const u = computeRiskUsage(ctx({ todayNetPnl: '-150' })).dailyLoss;
    expect(u).toMatchObject({
      used: '150',
      limitAmount: '300',
      limitPercent: '3',
      usedPercent: '1.50',
      shareOfLimit: '50.00',
      reached: false,
      problem: null,
    });
  });
  it('is exact at the boundary: 299.99 is not reached, 300 is', () => {
    expect(computeRiskUsage(ctx({ todayNetPnl: '-299.99' })).dailyLoss.reached).toBe(false);
    expect(computeRiskUsage(ctx({ todayNetPnl: '-300' })).dailyLoss.reached).toBe(true);
    expect(computeRiskUsage(ctx({ todayNetPnl: '-300.01' })).dailyLoss.shareOfLimit).toBe('100.01');
  });
  it('a profit today uses none of the limit', () => {
    const u = computeRiskUsage(ctx({ todayNetPnl: '250' })).dailyLoss;
    expect(u).toMatchObject({
      used: '0',
      usedPercent: '0.00',
      shareOfLimit: '0.00',
      reached: false,
    });
  });
  it('measures against the equity at the START of the day, not the current equity', () => {
    const u = computeRiskUsage(
      ctx({ equity: '9000', dayStartEquity: '12000', todayNetPnl: '-360' }),
    ).dailyLoss;
    expect(u).toMatchObject({ limitAmount: '360', reached: true, usedPercent: '3.00' });
  });
  it('rounds the shares UP so usage is never understated', () => {
    // 100 / 3000 = 3.3333 %  ->  3.34
    const u = computeRiskUsage(
      ctx({ dayStartEquity: '3000', todayNetPnl: '-100', settings: withSettings({}) }),
    ).dailyLoss;
    expect(u.usedPercent).toBe('3.34');
  });
  it('fails closed without day-start equity: nothing is shown as zero', () => {
    const u = computeRiskUsage(
      ctx({ dayStartEquity: null, dayStartProblem: 'Equity at the start of the day is zero.' }),
    ).dailyLoss;
    expect(u.used).toBeNull();
    expect(u.reached).toBeNull();
    expect(u.problem).toContain('start of the day');
    expect(u.limitPercent).toBe('3');
  });
});

describe('open risk usage', () => {
  it('hand-worked: |100-95| x 20 = 100 and |50-48| x 10 = 20 add up to 120 (1.20 % of equity, 40.00 % of 300)', () => {
    const u = computeRiskUsage(
      ctx({
        openTrades: [
          openTrade({ tradeId: 1 }),
          openTrade({ tradeId: 2, entryPrice: '50', initialStopLoss: '48', size: '10' }),
        ],
      }),
    ).openRisk;
    expect(u).toMatchObject({
      used: '120',
      limitAmount: '300',
      usedPercent: '1.20',
      shareOfLimit: '40.00',
      reached: false,
    });
  });
  it('no open trades is a verified zero', () => {
    expect(computeRiskUsage(ctx()).openRisk).toMatchObject({
      used: '0',
      reached: false,
      problem: null,
    });
  });
  it('reaching the limit exactly is flagged as reached', () => {
    const u = computeRiskUsage(
      ctx({ openTrades: [openTrade({ tradeId: 1, size: '60' })] }), // 5 x 60 = 300
    ).openRisk;
    expect(u).toMatchObject({ used: '300', reached: true, shareOfLimit: '100.00' });
  });
  it('an open trade in another currency makes it unverifiable (fail closed)', () => {
    const u = computeRiskUsage(
      ctx({ openTrades: [openTrade({ tradeId: 7, quoteCurrency: 'EUR' })] }),
    ).openRisk;
    expect(u.used).toBeNull();
    expect(u.reached).toBeNull();
    expect(u.problem).toContain('#7');
  });
  it('an open trade without a valid initial stop makes it unverifiable', () => {
    const u = computeRiskUsage(
      ctx({ openTrades: [openTrade({ tradeId: 3, initialStopLoss: null })] }),
    ).openRisk;
    expect(u.used).toBeNull();
    expect(u.problem).toContain('#3');
  });
  it('without verified equity nothing is shown', () => {
    const u = computeRiskUsage(
      ctx({ equity: null, equityProblem: 'Equity is zero or negative.' }),
    ).openRisk;
    expect(u.used).toBeNull();
    expect(u.problem).toContain('Equity is zero');
  });
});

describe('open trades usage', () => {
  it('counts and compares with the limit', () => {
    const three = [1, 2, 3].map((tradeId) => openTrade({ tradeId }));
    // 2 of 3 = 66.666... % -> rounded UP to 66.67 (never understated)
    expect(computeRiskUsage(ctx({ openTrades: three.slice(0, 2) })).openTrades).toEqual({
      used: 2,
      limit: 3,
      shareOfLimit: '66.67',
      reached: false,
    });
    expect(computeRiskUsage(ctx({ openTrades: three })).openTrades).toEqual({
      used: 3,
      limit: 3,
      shareOfLimit: '100.00',
      reached: true,
    });
    expect(computeRiskUsage(ctx()).openTrades.shareOfLimit).toBe('0.00');
  });
  it('has an unknown limit when the settings are invalid', () => {
    expect(computeRiskUsage(ctx({ settings: null, settingsProblem: 'bad' })).openTrades).toEqual({
      used: 0,
      limit: null,
      shareOfLimit: null,
      reached: null,
    });
  });
});

describe('drawdown usage', () => {
  it('hand-worked: a fall of 600 from a 12000 peak is 5.00 % and 50.00 % of the 1200 limit', () => {
    const u = computeRiskUsage(ctx({ peakEquity: '12000', fallFromPeak: '600' })).drawdown;
    expect(u).toMatchObject({
      used: '600',
      limitAmount: '1200',
      limitPercent: '10',
      usedPercent: '5.00',
      shareOfLimit: '50.00',
      reached: false,
    });
  });
  it('is exact at the boundary', () => {
    expect(
      computeRiskUsage(ctx({ peakEquity: '12000', fallFromPeak: '1199.99' })).drawdown.reached,
    ).toBe(false);
    expect(
      computeRiskUsage(ctx({ peakEquity: '12000', fallFromPeak: '1200' })).drawdown.reached,
    ).toBe(true);
  });
  it('no fall is a verified zero', () => {
    expect(computeRiskUsage(ctx()).drawdown).toMatchObject({
      used: '0',
      usedPercent: '0.00',
      reached: false,
    });
  });
  it('fails closed without a peak', () => {
    const u = computeRiskUsage(
      ctx({
        peakEquity: null,
        fallFromPeak: null,
        equityProblem: 'The starting balance is missing.',
      }),
    ).drawdown;
    expect(u.used).toBeNull();
    expect(u.problem).toContain('starting balance');
  });
});

describe('invalid settings', () => {
  it('every line says why, and no limit is invented', () => {
    const u = computeRiskUsage(ctx({ settings: null, settingsProblem: 'corrupt JSON' }));
    for (const line of [u.dailyLoss, u.openRisk, u.drawdown]) {
      expect(line.used).toBeNull();
      expect(line.limitPercent).toBeNull();
      expect(line.problem).toContain('corrupt JSON');
    }
  });
  it('does not change the context it explains', () => {
    const c = ctx({ todayNetPnl: '-10' });
    const copy = structuredClone(c);
    computeRiskUsage(c);
    expect(c).toEqual(copy);
  });
});

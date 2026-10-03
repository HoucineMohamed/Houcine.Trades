import { describe, expect, it } from 'vitest';
import { computeAccountStats } from './account';
import { input, trade } from './fixtures';

/** The worked example in docs/stats-glossary.md must stay true. */
describe('glossary worked example', () => {
  const c = computeAccountStats(
    input([
      trade({
        id: 1,
        entryPrice: '100',
        exitPrice: '110',
        size: '2',
        initialStopLoss: '95',
        fees: '1',
      }),
      trade({
        id: 2,
        direction: 'short',
        entryPrice: '200',
        exitPrice: '210',
        size: '1',
        initialStopLoss: '205',
        fees: '0.5',
      }),
    ]),
  ).currencies[0]!;
  const o = c.overall;

  it('matches the numbers printed in the glossary', () => {
    expect(
      c.tradeResults.map((r) => [
        r.grossPnl,
        r.netPnl,
        r.initialRisk.value,
        r.grossR.value,
        r.netR.value,
      ]),
    ).toEqual([
      ['20', '19', '10', '2.0000', '1.9000'],
      ['-10', '-10.5', '5', '-2.0000', '-2.1000'],
    ]);
    expect([o.wins, o.losses, o.winRatePercent.value]).toEqual([1, 1, '50.00']);
    expect([o.netPnl, o.totalWinners, o.totalLosers]).toEqual(['8.5', '19', '-10.5']);
    expect([o.profitFactor.value, o.payoffRatio.value]).toEqual(['1.8095', '1.8095']);
    expect(o.expectancyMoney.value).toBe('4.25000000');
    expect(o.averageR.value).toBe('0.0000');
    expect(o.expectancyR.value).toBe('-0.1000');
    expect(c.equityCurve.points.map((p) => p.equity)).toEqual(['1019', '1008.5']);
    expect(o.maxDrawdown).toMatchObject({ amount: '10.5', percent: { value: '1.03' } });
  });

  it('matches the other examples in the glossary', () => {
    // long, entry 100, exit 110, size 2, initial stop 95: gross 20, risk 10, R 2.0
    // a 1000 balance with +500, -100, -400 has max drawdown 500 (33.33 %): see edge-cases.test.ts
    expect(c.tradeResults[0]!.initialRisk.value).toBe('10');
  });
});

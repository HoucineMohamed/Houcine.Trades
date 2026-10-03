import { describe, expect, it } from 'vitest';
import { computeAccountStats } from './account';
import { analyzeEquityFrom } from './group';
import { input, trade } from './fixtures';

describe('analyzeEquityFrom (used by the risk engine)', () => {
  it('walks equity from a given start, ordered by closed time then id', () => {
    // start 1000: +500 -> 1500 (peak), -100 -> 1400 (fall 100), -400 -> 1000 (fall 500)
    const { curve, maxDrawdown } = analyzeEquityFrom('1000', [
      { tradeId: 3, closedAt: '2026-01-03T00:00:00.000Z', netPnl: '-400' },
      { tradeId: 1, closedAt: '2026-01-01T00:00:00.000Z', netPnl: '500' },
      { tradeId: 2, closedAt: '2026-01-02T00:00:00.000Z', netPnl: '-100' },
    ]);
    expect(curve.points.map((p) => [p.tradeId, p.equity, p.peak, p.fallFromPeak])).toEqual([
      [1, '1500', '1500', '0'],
      [2, '1400', '1500', '100'],
      [3, '1000', '1500', '500'],
    ]);
    expect(curve).toMatchObject({
      startingEquity: '1000',
      endingEquity: '1000',
      peakEquity: '1500',
    });
    expect(maxDrawdown.amount).toBe('500');
    expect(maxDrawdown.percent.value).toBe('33.33'); // 500 / 1500
  });

  it('with no trades: ending = peak = start, no fall', () => {
    const { curve, maxDrawdown } = analyzeEquityFrom('1234.5', []);
    expect(curve).toMatchObject({
      startingEquity: '1234.5',
      endingEquity: '1234.5',
      peakEquity: '1234.5',
      points: [],
    });
    expect(maxDrawdown.amount).toBe('0');
  });

  it('gives the same answer as the stats engine for the same trades', () => {
    const rows = [
      trade({ id: 1, exitPrice: '110', fees: '1' }),
      trade({ id: 2, exitPrice: '90' }),
      trade({ id: 3, exitPrice: '95' }),
    ];
    const c = computeAccountStats(input(rows)).currencies[0]!;
    const again = analyzeEquityFrom(
      '1000',
      c.tradeResults.map((r) => ({ tradeId: r.tradeId, closedAt: r.closedAt, netPnl: r.netPnl })),
    );
    expect(again.curve).toEqual(c.equityCurve);
    expect(again.maxDrawdown).toEqual(c.overall.maxDrawdown);
  });

  it('the stats curve now reports peak and ending equity', () => {
    const c = computeAccountStats(
      input([trade({ id: 1, exitPrice: '110' }), trade({ id: 2, exitPrice: '95' })]),
    ).currencies[0]!;
    // 1000 -> 1010 -> 1005
    expect(c.equityCurve).toMatchObject({ endingEquity: '1005', peakEquity: '1010' });
    expect(c.equityCurve.points[1]).toMatchObject({ peak: '1010', fallFromPeak: '5' });
  });
});

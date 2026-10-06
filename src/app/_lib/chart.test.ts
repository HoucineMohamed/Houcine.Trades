import { describe, expect, it } from 'vitest';
import type { EquityCurve, RBucket } from '@/domain/stats';
import { computeRDistribution } from '@/domain/stats';
import { equityGeometry, histogramGeometry, makeFrame, scaleLinear, usageBar } from './chart';

const point = (tradeId: number, equity: string, peak: string, fall: string) => ({
  tradeId,
  closedAt: `2026-01-0${tradeId}T10:00:00.000Z`,
  netPnl: '0',
  equity,
  peak,
  fallFromPeak: fall,
});
const curve = (over: Partial<EquityCurve> = {}): EquityCurve => ({
  startsFromAccountBalance: true,
  startingEquity: '1000',
  endingEquity: '1000',
  peakEquity: '1000',
  points: [],
  ...over,
});
const frame = makeFrame(100, 100, { left: 0, right: 0, top: 0, bottom: 0 });

describe('scaleLinear', () => {
  it('maps the ends and the middle', () => {
    const s = scaleLinear(0, 10, 100, 0);
    expect([s(0), s(5), s(10)]).toEqual([100, 50, 0]);
  });
  it('a flat domain maps to the middle of the range (no division by zero)', () => {
    expect(scaleLinear(5, 5, 0, 100)(5)).toBe(50);
  });
});

describe('makeFrame', () => {
  it('computes the drawing area from the margins', () => {
    expect(makeFrame(640, 240)).toEqual({
      width: 640,
      height: 240,
      left: 12,
      right: 628,
      top: 12,
      bottom: 212,
    });
  });
});

describe('equityGeometry', () => {
  it('hand-worked: 1000 -> 1100 -> 1050 -> 1200 in a 100x100 frame', () => {
    const c = curve({
      endingEquity: '1200',
      peakEquity: '1200',
      points: [
        point(1, '1100', '1100', '0'),
        point(2, '1050', '1100', '50'),
        point(3, '1200', '1200', '0'),
      ],
    });
    const g = equityGeometry(c, frame);
    // domain 1000..1200 -> y 100..0 ; x = i/3 * 100
    expect(g.line).toBe('M 0 100 L 33.33 50 L 66.67 75 L 100 0');
    expect(g.startY).toBe(100);
    expect(g.highLabel).toBe('1200');
    expect(g.lowLabel).toBe('1000');
    expect(g.hasDrawdown).toBe(true);
    // peak line forward then equity line back
    expect(g.drawdown).toBe(
      'M 0 100 L 33.33 50 L 66.67 50 L 100 0 L 100 0 L 66.67 75 L 33.33 50 L 0 100 Z',
    );
    expect(g.dots.map((d) => d.tradeId)).toEqual([null, 1, 2, 3]);
  });
  it('uses the engine text for the labels, not recomputed numbers', () => {
    const c = curve({
      points: [point(1, '999.12345678', '1000', '0.87654322')],
      peakEquity: '1000',
    });
    const g = equityGeometry(c, frame);
    expect(g.lowLabel).toBe('999.12345678');
    expect(g.highLabel).toBe('1000');
  });
  it('no trades: a single centred point, no drawdown shape', () => {
    const g = equityGeometry(curve(), frame);
    expect(g.line).toBe('M 50 50');
    expect(g.drawdown).toBe('');
    expect(g.hasDrawdown).toBe(false);
    expect(g.dots).toHaveLength(1);
  });
  it('equity that never falls has no drawdown shape', () => {
    const g = equityGeometry(
      curve({ endingEquity: '1100', peakEquity: '1100', points: [point(1, '1100', '1100', '0')] }),
      frame,
    );
    expect(g.hasDrawdown).toBe(false);
    expect(g.drawdown).toBe('');
  });
  it('a flat curve (all equal) does not divide by zero', () => {
    const g = equityGeometry(curve({ points: [point(1, '1000', '1000', '0')] }), frame);
    expect(g.line).toBe('M 0 50 L 100 50');
  });
  it('stays inside the frame', () => {
    const f = makeFrame(640, 240);
    const c = curve({
      endingEquity: '900',
      peakEquity: '1500',
      points: [point(1, '1500', '1500', '0'), point(2, '900', '1500', '600')],
    });
    for (const d of equityGeometry(c, f).dots) {
      expect(d.x).toBeGreaterThanOrEqual(f.left);
      expect(d.x).toBeLessThanOrEqual(f.right);
      expect(d.y).toBeGreaterThanOrEqual(f.top);
      expect(d.y).toBeLessThanOrEqual(f.bottom);
    }
  });
});

describe('histogramGeometry', () => {
  const buckets = computeRDistribution([]).buckets;
  const withCounts = (counts: Record<string, number>): RBucket[] =>
    buckets.map((b) => ({ ...b, count: counts[b.label] ?? 0 }));

  it('the tallest bar fills the plot, others scale, empty bars have no height', () => {
    const g = histogramGeometry(withCounts({ '0 to 0.5': 4, '2 to 2.5': 2 }), frame);
    expect(g.maxCount).toBe(4);
    const tall = g.bars.find((b) => b.label === '0 to 0.5');
    const half = g.bars.find((b) => b.label === '2 to 2.5');
    const none = g.bars.find((b) => b.label === '-3 to -2.5');
    expect(tall?.height).toBe(100);
    expect(half?.height).toBe(50);
    expect(none?.height).toBe(0);
  });
  it('no trades at all: every bar has zero height', () => {
    const g = histogramGeometry(buckets, frame);
    expect(g.maxCount).toBe(0);
    expect(g.bars.every((b) => b.height === 0)).toBe(true);
  });
  it('buckets below 0 R are "below", the others "above"; the 0 R edge is found', () => {
    const g = histogramGeometry(withCounts({}), makeFrame(1400, 100, { left: 0, right: 0 }));
    expect(g.bars.find((b) => b.label === 'below -3')?.side).toBe('below');
    expect(g.bars.find((b) => b.label === '-0.5 to 0')?.side).toBe('below');
    expect(g.bars.find((b) => b.label === '0 to 0.5')?.side).toBe('above');
    expect(g.zeroX).toBe(700); // 7 of 14 buckets to the left
  });
  it('bars never overlap and stay in the frame', () => {
    const f = makeFrame(640, 200);
    const g = histogramGeometry(withCounts({ '1 to 1.5': 3 }), f);
    for (let i = 1; i < g.bars.length; i++) {
      const prev = g.bars[i - 1]!;
      expect(g.bars[i]!.x).toBeGreaterThanOrEqual(prev.x + prev.width);
    }
    expect(g.bars.at(-1)!.x + g.bars.at(-1)!.width).toBeLessThanOrEqual(f.right);
  });
});

describe('usageBar', () => {
  it('fills by the share of the limit', () => {
    expect(usageBar('0.00')).toEqual({ fill: 0, over: false, known: true });
    expect(usageBar('50.00')).toEqual({ fill: 50, over: false, known: true });
    expect(usageBar('100.00')).toEqual({ fill: 100, over: false, known: true });
  });
  it('above 100 % the bar is full and flagged over', () => {
    expect(usageBar('100.01')).toEqual({ fill: 100, over: true, known: true });
    expect(usageBar('250')).toEqual({ fill: 100, over: true, known: true });
  });
  it('unknown or broken input is shown as unknown, never as empty', () => {
    expect(usageBar(null)).toEqual({ fill: 0, over: false, known: false });
    expect(usageBar('abc')).toEqual({ fill: 0, over: false, known: false });
    expect(usageBar('-5')).toEqual({ fill: 0, over: false, known: false });
  });
});

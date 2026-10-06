import { describe, expect, it } from 'vitest';
import { computeAccountStats } from './account';
import { computeRDistribution } from './distribution';
import { input, trade } from './fixtures';

// Every trade: long, entry 100, initial stop 95 (risk 5), size 1, no fees, so net R = (exit - 100) / 5.
const rTrade = (id: number, exit: string, over = {}) => trade({ id, exitPrice: exit, ...over });

function distribution(trades: ReturnType<typeof trade>[]) {
  const stats = computeAccountStats(input(trades)).currencies[0];
  return computeRDistribution(stats?.tradeResults ?? []);
}
const countsByLabel = (d: ReturnType<typeof distribution>) =>
  Object.fromEntries(d.buckets.filter((b) => b.count > 0).map((b) => [b.label, b.count]));

describe('R distribution', () => {
  it('has 14 buckets: 12 of 0.5 R from -3 to 3, plus an open one at each end', () => {
    const d = distribution([]);
    expect(d.buckets).toHaveLength(14);
    expect(d.buckets[0]).toMatchObject({ lower: null, upper: '-3', label: 'below -3' });
    expect(d.buckets[1]).toMatchObject({ lower: '-3', upper: '-2.5', label: '-3 to -2.5' });
    expect(d.buckets[13]).toMatchObject({ lower: '3', upper: null, label: '3 and above' });
    expect(d).toMatchObject({ total: 0, unavailable: 0 });
  });

  it('hand-worked: R of +2, -1, +2.2, 0 land in their buckets', () => {
    const d = distribution([
      rTrade(1, '110'), //  +2.0000
      rTrade(2, '95'), //   -1.0000
      rTrade(3, '111'), //  +2.2000
      rTrade(4, '100'), //   0.0000
    ]);
    expect(countsByLabel(d)).toEqual({ '2 to 2.5': 2, '-1 to -0.5': 1, '0 to 0.5': 1 });
    expect(d.total).toBe(4);
  });

  it('a trade exactly on an edge belongs to the bucket that STARTS there', () => {
    const d = distribution([
      rTrade(1, '85'), //    -3.0000 -> "-3 to -2.5"
      rTrade(2, '112.5'), //  2.5000 -> "2.5 to 3"
      rTrade(3, '115'), //    3.0000 -> "3 and above"
      rTrade(4, '97.5'), //  -0.5000 -> "-0.5 to 0"
    ]);
    expect(countsByLabel(d)).toEqual({
      '-3 to -2.5': 1,
      '2.5 to 3': 1,
      '3 and above': 1,
      '-0.5 to 0': 1,
    });
  });

  it('one unit under an edge stays in the bucket below', () => {
    const d = distribution([rTrade(1, '84.9995'), rTrade(2, '112.4995')]); // -3.0001 and 2.4999
    expect(countsByLabel(d)).toEqual({ 'below -3': 1, '2 to 2.5': 1 });
  });

  it('puts extreme trades in the open buckets', () => {
    const d = distribution([rTrade(1, '1'), rTrade(2, '500')]);
    expect(countsByLabel(d)).toEqual({ 'below -3': 1, '3 and above': 1 });
  });

  it('counts trades without a net R separately, never as zero', () => {
    const d = distribution([rTrade(1, '110'), rTrade(2, '110', { initialStopLoss: null })]);
    expect(d.total).toBe(1);
    expect(d.unavailable).toBe(1);
    expect(countsByLabel(d)).toEqual({ '2 to 2.5': 1 });
  });

  it('uses R after fees: fees move a trade down a bucket', () => {
    // gross R = +2.0000, fees 2.5 on risk 5 -> net R = +1.5000
    const d = distribution([rTrade(1, '110', { fees: '2.5' })]);
    expect(countsByLabel(d)).toEqual({ '1.5 to 2': 1 });
  });

  it('the bucket counts always add up to the total, whatever the order of the input', () => {
    const exits = ['80', '90', '95', '99', '100', '101', '105', '110', '120', '125'];
    const trades = exits.map((e, i) => rTrade(i + 1, e));
    const forward = distribution(trades);
    const reversed = distribution([...trades].reverse());
    expect(forward.buckets.reduce((n, b) => n + b.count, 0)).toBe(forward.total);
    expect(forward.total).toBe(10);
    expect(reversed.buckets.map((b) => b.count)).toEqual(forward.buckets.map((b) => b.count));
  });

  it('edges next to the top and around zero', () => {
    const d = distribution([
      rTrade(1, '114.9995'), //  2.9999 -> "2.5 to 3"
      rTrade(2, '100'), //       0.0000 -> "0 to 0.5"
      rTrade(3, '99.9995'), //  -0.0001 -> "-0.5 to 0"
    ]);
    expect(countsByLabel(d)).toEqual({ '2.5 to 3': 1, '0 to 0.5': 1, '-0.5 to 0': 1 });
  });
});

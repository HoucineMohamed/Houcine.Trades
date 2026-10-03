import { describe, expect, it } from 'vitest';
import { Dec } from '../money/decimal';
import { computeAccountStats } from './account';
import { input, trade } from './fixtures';
import type { StatsTrade } from './types';

/**
 * Invariant tests: properties that must hold for ANY data. They run over many pseudo-random
 * datasets from a fixed seed (so a failure is always reproducible). No money floats are used:
 * prices are built from whole numbers as text.
 */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whole number -> decimal text with `places` decimals (no floating point). */
function decimalText(n: number, places: number): string {
  const digits = String(n).padStart(places + 1, '0');
  const cut = digits.length - places;
  return places === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

function randomDataset(seed: number): StatsTrade[] {
  const rnd = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(items: T[]) => items[int(0, items.length - 1)]!;
  const count = int(0, 40);
  return Array.from({ length: count }, (_, i) => {
    const entryUnits = int(1000, 200000); // price 10.00 .. 2000.00
    const exitUnits = Math.max(1, entryUnits + int(-300, 300));
    const direction = pick(['long', 'short']);
    const stopUnits = direction === 'long' ? entryUnits - int(1, 200) : entryUnits + int(1, 200);
    const quote = pick(['USDT', 'USDT', 'USDT', 'EUR', 'BTC']);
    const hasSetup = rnd() < 0.7;
    const setupId = hasSetup ? int(1, 3) : null;
    return trade({
      id: i + 1,
      symbol: pick(['BTCUSDT', 'ETHUSDT', 'AAPL', 'EURUSD']),
      assetClass: pick(['crypto', 'stock', 'forex']),
      direction,
      quoteCurrency: quote,
      entryPrice: decimalText(entryUnits, 2),
      exitPrice: decimalText(exitUnits, 2),
      initialStopLoss: rnd() < 0.1 ? null : decimalText(Math.max(1, stopUnits), 2),
      size: decimalText(int(1, 5000), 4), // 0.0001 .. 0.5
      fees: decimalText(int(0, 500), 4),
      feesCurrency: rnd() < 0.15 ? 'BNB' : quote,
      closedAt: new Date(Date.UTC(2026, 0, 1) + int(0, 20) * 3600_000).toISOString(),
      setupId,
      setupName: setupId === null ? null : `Setup ${setupId}`,
    });
  });
}

const START = '1000000'; // big enough that equity never goes negative in these datasets
const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
const D = (v: string) => new Dec(v);
const sum = (values: string[]) => values.reduce((acc, v) => acc.plus(D(v)), new Dec(0));

describe.each(SEEDS)('invariants, dataset %i', (seed) => {
  const trades = randomDataset(seed);
  const stats = computeAccountStats(input(trades, { startingBalance: START }));

  it('counts add up and win rate = wins / total', () => {
    for (const c of stats.currencies) {
      const o = c.overall;
      expect(o.wins + o.losses + o.breakevens).toBe(o.tradeCount);
      if (o.tradeCount > 0) {
        const expected = new Dec(o.wins)
          .div(o.tradeCount)
          .times(100)
          .toDecimalPlaces(2, Dec.ROUND_HALF_EVEN)
          .toFixed(2);
        expect(o.winRatePercent.value).toBe(expected);
      } else {
        expect(o.winRatePercent.value).toBeNull();
      }
    }
  });

  it('final equity = starting balance + net P&L (base currency)', () => {
    const base = stats.currencies.find((c) => c.isBaseCurrency)!;
    const last = base.equityCurve.points.at(-1)?.equity ?? START;
    expect(D(last).eq(D(START).plus(D(base.overall.netPnl)))).toBe(true);
    // Other currencies start at 0: final equity = net P&L only.
    for (const c of stats.currencies.filter((x) => !x.isBaseCurrency)) {
      const end = c.equityCurve.points.at(-1)?.equity ?? '0';
      expect(D(end).eq(D(c.overall.netPnl))).toBe(true);
    }
  });

  it('money identities: gross - fees = net ; winners + losers = net ; per-trade sums match', () => {
    for (const c of stats.currencies) {
      const o = c.overall;
      expect(D(o.grossPnl).minus(D(o.totalFees)).eq(D(o.netPnl))).toBe(true);
      expect(D(o.totalWinners).plus(D(o.totalLosers)).eq(D(o.netPnl))).toBe(true);
      expect(sum(c.tradeResults.map((r) => r.netPnl)).eq(D(o.netPnl))).toBe(true);
      expect(sum(c.tradeResults.map((r) => r.grossPnl)).eq(D(o.grossPnl))).toBe(true);
      expect(D(o.totalWinners).gte(0)).toBe(true);
      expect(D(o.totalLosers).lte(0)).toBe(true);
    }
  });

  it('currencies never mix: every trade is counted exactly once, in its own currency', () => {
    const counted = stats.currencies.reduce(
      (n, c) => n + c.overall.tradeCount + c.skipped.length,
      0,
    );
    expect(counted).toBe(trades.length);
    for (const c of stats.currencies) {
      const expected = trades.filter((t) => t.quoteCurrency === c.quoteCurrency).length;
      expect(c.overall.tradeCount + c.skipped.length).toBe(expected);
    }
  });

  it('every breakdown is a partition of its currency group', () => {
    for (const c of stats.currencies) {
      for (const list of [c.bySetup, c.bySymbol, c.byDirection, c.byAssetClass]) {
        expect(list.reduce((n, b) => n + b.stats.tradeCount, 0)).toBe(c.overall.tradeCount);
        expect(sum(list.map((b) => b.stats.netPnl)).eq(D(c.overall.netPnl))).toBe(true);
      }
    }
  });

  it('max drawdown matches an independent recomputation and never exceeds the peak equity', () => {
    for (const c of stats.currencies) {
      const start = c.equityCurve.startsFromAccountBalance ? D(START) : new Dec(0);
      let peak = start;
      let maxAmount = new Dec(0);
      let bestPct: Dec | null = null;
      let bestPctAmount = new Dec(0);
      for (const p of c.equityCurve.points) {
        const e = D(p.equity);
        if (e.gt(peak)) peak = e;
        const fall = peak.minus(e);
        if (fall.gt(maxAmount)) maxAmount = fall;
        if (c.equityCurve.startsFromAccountBalance && peak.gt(0)) {
          const pct = fall.div(peak).times(100);
          if (bestPct === null || pct.gt(bestPct)) {
            bestPct = pct;
            bestPctAmount = fall;
          }
        }
      }
      const dd = c.overall.maxDrawdown;
      if (c.equityCurve.startsFromAccountBalance && bestPct !== null) {
        expect(D(dd.amount).eq(bestPctAmount)).toBe(true);
        expect(dd.percent.value).toBe(bestPct.toDecimalPlaces(2, Dec.ROUND_HALF_EVEN).toFixed(2));
        expect(Number(dd.percent.value)).toBeGreaterThanOrEqual(0);
        expect(Number(dd.percent.value)).toBeLessThanOrEqual(100);
      } else {
        expect(D(dd.amount).eq(maxAmount)).toBe(true);
      }
      if (c.equityCurve.startsFromAccountBalance) {
        // With a real (large, positive) balance the equity never goes below zero, so a fall can
        // never be bigger than the highest equity reached.
        expect(D(dd.amount).lte(peak)).toBe(true);
      } else {
        // A curve that starts at 0 can go negative, so it can fall further than its peak. The
        // honest bound is: a fall never exceeds the full range between the peak and the lowest point.
        const lowest = c.equityCurve.points.reduce(
          (m, p) => (D(p.equity).lt(m) ? D(p.equity) : m),
          start,
        );
        expect(D(dd.amount).lte(peak.minus(lowest))).toBe(true);
      }
      expect(D(dd.amount).gte(0)).toBe(true);
    }
  });

  it('profit factor, payoff ratio and R are consistent with their parts', () => {
    for (const c of stats.currencies) {
      const o = c.overall;
      if (o.losses === 0) {
        expect(o.profitFactor.value).toBeNull();
        expect(o.averageLoss.value).toBeNull();
      } else {
        const pf = D(o.totalWinners).div(D(o.totalLosers).abs());
        expect(o.profitFactor.value).toBe(pf.toDecimalPlaces(4, Dec.ROUND_HALF_EVEN).toFixed(4));
      }
      expect(o.flags.netRTradeCount).toBeLessThanOrEqual(o.flags.rTradeCount);
      expect(o.flags.rTradeCount).toBeLessThanOrEqual(o.tradeCount);
      expect(o.longestWinStreak).toBeLessThanOrEqual(o.wins);
      expect(o.longestLossStreak).toBeLessThanOrEqual(o.losses);
    }
  });

  it('is deterministic: input order does not matter', () => {
    const shuffled = [...trades].reverse();
    expect(computeAccountStats(input(shuffled, { startingBalance: START }))).toEqual(stats);
  });
});

describe('invariants: sanity of the generator', () => {
  it('produces non-trivial datasets (so the invariants above are not vacuous)', () => {
    const sizes = SEEDS.map((s) => randomDataset(s).length);
    expect(Math.max(...sizes)).toBeGreaterThan(20);
    expect(sizes.filter((n) => n === 0).length).toBeLessThan(10);
    const flagged = SEEDS.flatMap(
      (s) => computeAccountStats(input(randomDataset(s))).currencies,
    ).some((c) => c.overall.flags.tradesWithExcludedFees > 0);
    expect(flagged).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { computeAccountStats } from './account';
import { input, trade } from './fixtures';

const base = (trades: Parameters<typeof input>[0], account = {}) =>
  computeAccountStats(input(trades, account)).currencies[0]!;

describe('no trades', () => {
  const c = computeAccountStats(input([])).currencies;
  const o = c[0]!.overall;

  it('still returns the base currency group, all empty, nothing crashes', () => {
    expect(c.map((x) => x.quoteCurrency)).toEqual(['USDT']);
    expect(o.tradeCount).toBe(0);
    expect([o.wins, o.losses, o.breakevens]).toEqual([0, 0, 0]);
    for (const total of [o.grossPnl, o.totalFees, o.netPnl, o.totalWinners, o.totalLosers]) {
      expect(total).toBe('0');
    }
  });

  it('every ratio is null with a reason (no division by zero)', () => {
    for (const m of [
      o.winRatePercent,
      o.averageWin,
      o.averageLoss,
      o.largestWin,
      o.largestLoss,
      o.averageR,
      o.expectancyR,
      o.expectancyMoney,
      o.profitFactor,
      o.payoffRatio,
      o.maxDrawdown.percent,
    ]) {
      expect(m.value).toBeNull();
      expect(m.reason).toMatch(/no |never/);
    }
    expect(o.maxDrawdown.amount).toBe('0');
    expect(o.longestWinStreak + o.longestLossStreak).toBe(0);
    expect(c[0]!.equityCurve.points).toEqual([]);
    expect(c[0]!.equityCurve.startingEquity).toBe('1000');
  });

  it('warns about the sample size', () => {
    expect(o.sampleSize).toMatchObject({ reliable: false, tradeCount: 0 });
    expect(o.sampleSize.warning).toMatch(/Only 0 closed trades/);
  });
});

describe('a single trade', () => {
  it('a win: 100 %, no losses so profit factor and payoff are null with reasons', () => {
    // long 100 -> 110, size 1: +10. Equity 1000 -> 1010: no fall at all.
    const o = base([trade({ id: 1 })]).overall;
    expect(o.tradeCount).toBe(1);
    expect(o.winRatePercent.value).toBe('100.00');
    expect(o.netPnl).toBe('10');
    expect(o.profitFactor).toEqual({
      value: null,
      reason: expect.stringMatching(/no losing trades/),
    });
    expect(o.payoffRatio).toEqual({ value: null, reason: 'no losing trades' });
    expect(o.averageLoss.value).toBeNull();
    expect(o.maxDrawdown.amount).toBe('0');
    expect(o.maxDrawdown.percent.value).toBe('0.00');
    expect(o.sampleSize.warning).toMatch(/Only 1 closed trade\./); // singular
  });

  it('a loss: drawdown from the very first trade counts', () => {
    // long 100 -> 90, size 1: -10. Equity 1000 -> 990: fall 10 = 10/1000 = 1.00 %
    const o = base([trade({ id: 1, exitPrice: '90' })]).overall;
    expect(o.winRatePercent.value).toBe('0.00');
    expect(o.netPnl).toBe('-10');
    expect(o.profitFactor.value).toBe('0.0000'); // 0 / 10
    expect(o.payoffRatio).toEqual({ value: null, reason: 'no winning trades' });
    expect(o.averageWin.value).toBeNull();
    expect(o.maxDrawdown.amount).toBe('10');
    expect(o.maxDrawdown.percent.value).toBe('1.00');
  });

  it('a breakeven: neither win nor loss', () => {
    const o = base([trade({ id: 1, exitPrice: '100' })]).overall;
    expect([o.wins, o.losses, o.breakevens]).toEqual([0, 0, 1]);
    expect(o.winRatePercent.value).toBe('0.00');
    expect(o.profitFactor.value).toBeNull();
    expect(o.payoffRatio.value).toBeNull();
    expect(o.longestWinStreak + o.longestLossStreak).toBe(0);
  });
});

describe('all wins and all losses', () => {
  it('all wins', () => {
    // +10, +20, +30 (long 100 -> 110/120/130): never a fall
    const o = base([
      trade({ id: 1, exitPrice: '110' }),
      trade({ id: 2, exitPrice: '120' }),
      trade({ id: 3, exitPrice: '130' }),
    ]).overall;
    expect(o.winRatePercent.value).toBe('100.00');
    expect(o.netPnl).toBe('60');
    expect(o.profitFactor.value).toBeNull();
    expect(o.longestWinStreak).toBe(3);
    expect(o.longestLossStreak).toBe(0);
    expect(o.maxDrawdown).toMatchObject({ amount: '0', percent: { value: '0.00' } });
  });

  it('all losses', () => {
    // -10 each (long 100 -> 90) x3: equity 1000 -> 990 -> 980 -> 970. Fall 30 = 3.00 % of 1000
    const o = base([
      trade({ id: 1, exitPrice: '90' }),
      trade({ id: 2, exitPrice: '90' }),
      trade({ id: 3, exitPrice: '90' }),
    ]).overall;
    expect(o.winRatePercent.value).toBe('0.00');
    expect(o.netPnl).toBe('-30');
    expect(o.profitFactor.value).toBe('0.0000');
    expect(o.longestLossStreak).toBe(3);
    expect(o.maxDrawdown.amount).toBe('30');
    expect(o.maxDrawdown.percent.value).toBe('3.00');
  });
});

describe('streaks', () => {
  it('a breakeven trade ends a losing streak', () => {
    // L, BE, L: the two losses are NOT consecutive
    const o = base([
      trade({ id: 1, exitPrice: '90' }),
      trade({ id: 2, exitPrice: '100' }),
      trade({ id: 3, exitPrice: '90' }),
    ]).overall;
    expect(o.longestLossStreak).toBe(1);
  });

  it('order is by closed time, not by id, and ties fall back to id', () => {
    const rows = [
      trade({ id: 1, exitPrice: '90', closedAt: '2026-02-03T10:00:00.000Z' }), // last
      trade({ id: 2, exitPrice: '110', closedAt: '2026-02-01T10:00:00.000Z' }), // first
      trade({ id: 4, exitPrice: '90', closedAt: '2026-02-02T10:00:00.000Z' }), // tie with id 3, after it
      trade({ id: 3, exitPrice: '110', closedAt: '2026-02-02T10:00:00.000Z' }),
    ];
    const c = base(rows);
    expect(c.equityCurve.points.map((p) => p.tradeId)).toEqual([2, 3, 4, 1]);
    // W (2), W (3), L (4), L (1)
    expect(c.overall.longestWinStreak).toBe(2);
    expect(c.overall.longestLossStreak).toBe(2);
  });
});

describe('currencies are never mixed', () => {
  const rows = [
    trade({ id: 1, quoteCurrency: 'USDT', feesCurrency: 'USDT', exitPrice: '110' }), // +10 USDT
    trade({ id: 2, quoteCurrency: 'EUR', feesCurrency: 'EUR', exitPrice: '120' }), // +20 EUR
    trade({ id: 3, quoteCurrency: 'EUR', feesCurrency: 'EUR', exitPrice: '90' }), // -10 EUR
  ];
  const stats = computeAccountStats(input(rows));

  it('gives each currency its own group: base currency first', () => {
    expect(stats.currencies.map((c) => c.quoteCurrency)).toEqual(['USDT', 'EUR']);
    expect(stats.currencies.map((c) => c.isBaseCurrency)).toEqual([true, false]);
  });

  it('never adds amounts across currencies', () => {
    const [usdt, eur] = stats.currencies;
    expect(usdt!.overall.netPnl).toBe('10'); // not 20 (10 + 20 - 10)
    expect(eur!.overall.netPnl).toBe('10'); // 20 - 10
    expect(usdt!.overall.tradeCount).toBe(1);
    expect(eur!.overall.tradeCount).toBe(2);
  });

  it('only the base currency starts from the account balance', () => {
    const [usdt, eur] = stats.currencies;
    expect(usdt!.equityCurve).toMatchObject({
      startsFromAccountBalance: true,
      startingEquity: '1000',
    });
    expect(usdt!.equityCurve.points.map((p) => p.equity)).toEqual(['1010']);
    // EUR: starts at 0 -> 20 -> 10 ; drawdown AMOUNT is computed (10), the percent is not
    expect(eur!.equityCurve).toMatchObject({
      startsFromAccountBalance: false,
      startingEquity: '0',
    });
    expect(eur!.equityCurve.points.map((p) => p.equity)).toEqual(['20', '10']);
    expect(eur!.overall.maxDrawdown.amount).toBe('10');
    expect(eur!.overall.maxDrawdown.percent.value).toBeNull();
    expect(eur!.overall.maxDrawdown.percent.reason).toMatch(
      /starting balance is in USDT, not EUR.*never converted/,
    );
    expect(eur!.notes.join(' ')).toMatch(
      /set the account base currency to the currency you actually trade in/,
    );
    expect(usdt!.notes).toEqual([]);
  });

  it('breakdowns stay inside their currency', () => {
    const eur = stats.currencies[1]!;
    expect(eur.bySymbol.map((b) => [b.label, b.stats.tradeCount])).toEqual([['BTCUSDT', 2]]);
  });

  it('a base-currency group exists even if every trade is in another currency', () => {
    const only = computeAccountStats(input([rows[1]!]));
    expect(only.currencies.map((c) => c.quoteCurrency)).toEqual(['USDT', 'EUR']);
    expect(only.currencies[0]!.overall.tradeCount).toBe(0);
  });
});

describe('fees in another currency (never converted, always flagged)', () => {
  // long 100 -> 110 size 1, initial stop 95: gross 10, risk 5, gross R 2.
  const rows = [
    trade({ id: 1, fees: '1', feesCurrency: 'USDT' }), // net 9, net R 1.8
    trade({ id: 2, fees: '5', feesCurrency: 'BNB' }), // fees left out: net = gross = 10, net R unavailable
    trade({ id: 3, fees: '0', feesCurrency: 'BNB' }), // zero fees: never flagged
  ];
  const c = base(rows);

  it('leaves the foreign fees out of the net figure and flags the trade', () => {
    const r2 = c.tradeResults.find((r) => r.tradeId === 2)!;
    expect(r2).toMatchObject({
      grossPnl: '10',
      feesApplied: '0',
      feesExcluded: true,
      netPnl: '10',
    });
    expect(r2.grossR.value).toBe('2.0000');
    expect(r2.netR.value).toBeNull();
    expect(r2.netR.reason).toMatch(/fees are in a different currency/);
  });

  it('does not flag zero fees in another currency', () => {
    const r3 = c.tradeResults.find((r) => r.tradeId === 3)!;
    expect(r3.feesExcluded).toBe(false);
    expect(r3.netR.value).toBe('2.0000');
  });

  it('counts flagged trades in the group and keeps net R to the trades that have it', () => {
    // fees deducted: only the 1 USDT. gross 30, net 9 + 10 + 10 = 29
    expect(c.overall.totalFees).toBe('1');
    expect(c.overall.grossPnl).toBe('30');
    expect(c.overall.netPnl).toBe('29');
    expect(c.overall.flags).toEqual({
      tradesWithExcludedFees: 1,
      rTradeCount: 3,
      netRTradeCount: 2,
    });
    // expectancy R uses only trades 1 and 3: (1.8 + 2) / 2 = 1.9 ; average gross R = 2
    expect(c.overall.expectancyR.value).toBe('1.9000');
    expect(c.overall.averageR.value).toBe('2.0000');
  });
});

describe('R uses the initial stop', () => {
  it('a trade without an initial stop still counts for P&L but has no R', () => {
    const c = base([trade({ id: 1, initialStopLoss: null })]);
    expect(c.overall.netPnl).toBe('10');
    expect(c.tradeResults[0]!.grossR).toEqual({
      value: null,
      reason: 'no initial stop-loss recorded for this trade',
    });
    expect(c.overall.averageR.value).toBeNull();
    expect(c.overall.averageR.reason).toMatch(/initial stop-loss/);
    expect(c.overall.flags.rTradeCount).toBe(0);
  });

  it('zero initial risk gives no R instead of dividing by zero', () => {
    const c = base([trade({ id: 1, initialStopLoss: '100' })]);
    expect(c.tradeResults[0]!.grossR.reason).toMatch(/zero risk/);
    expect(c.overall.netPnl).toBe('10');
  });

  it('the engine input carries no live stop, so a moved stop cannot leak in', () => {
    expect(Object.keys(trade({ id: 1 }))).not.toContain('stopLoss');
  });
});

describe('tiny and huge amounts stay exact', () => {
  it('size 0.00000001 on a big price', () => {
    // (65001.12345678 - 65000.12345678) x 0.00000001 = 1 x 0.00000001 = 0.00000001
    const r = base([
      trade({
        id: 1,
        entryPrice: '65000.12345678',
        exitPrice: '65001.12345678',
        size: '0.00000001',
        initialStopLoss: '64000',
      }),
    ]);
    expect(r.tradeResults[0]!.grossPnl).toBe('0.00000001');
    expect(r.overall.netPnl).toBe('0.00000001');
    expect(r.overall.expectancyMoney.value).toBe('0.00000001');
  });

  it('18-decimal prices times an 18-decimal size give an exact 36-decimal result (no exponent)', () => {
    // (3e-18 - 1e-18) x 2e-18 = 2e-18 x 2e-18 = 4e-36
    const r = base([
      trade({
        id: 1,
        entryPrice: '0.000000000000000001',
        exitPrice: '0.000000000000000003',
        size: '0.000000000000000002',
        initialStopLoss: '0.0000000000000000005',
      }),
    ]);
    expect(r.tradeResults[0]!.grossPnl).toBe('0.000000000000000000000000000000000004');
  });

  it('0.1 + 0.2 style sums are exact', () => {
    // +0.1 and +0.2 : net must be exactly 0.3
    const r = base([
      trade({ id: 1, entryPrice: '1', exitPrice: '1.1', size: '1', initialStopLoss: '0.5' }),
      trade({ id: 2, entryPrice: '1', exitPrice: '1.2', size: '1', initialStopLoss: '0.5' }),
    ]);
    expect(r.overall.netPnl).toBe('0.3');
  });

  it('rounding is half-even and never shows negative zero', () => {
    // one loss of exactly 0.000000001 (1e-9): expectancy money rounds to 8 places -> "0.00000000", not "-0.00000000"
    const r = base([
      trade({
        id: 1,
        entryPrice: '1',
        exitPrice: '0.999999999',
        size: '1',
        initialStopLoss: '0.5',
      }),
    ]);
    expect(r.overall.netPnl).toBe('-0.000000001');
    expect(r.overall.expectancyMoney.value).toBe('0.00000000');
  });
});

describe('drawdown definitions', () => {
  it('uses the deepest fall by PERCENT, with the amount of that same fall', () => {
    // entry 10000, size 1 so P&L = exit - 10000. Start 1000:
    //   -500 -> 500 (fall 500 from peak 1000 = 50 %), +4500 -> 5000 (new peak), -1000 -> 4000
    //   (fall 1000 from peak 5000 = 20 %). The biggest AMOUNT is 1000 but the deepest PERCENT is
    //   the first fall, so the answer is amount 500, percent 50.00.
    const t = (id: number, pnl: number) =>
      trade({
        id,
        entryPrice: '10000',
        exitPrice: String(10000 + pnl),
        size: '1',
        initialStopLoss: '9000',
      });
    const o = base([t(1, -500), t(2, 4500), t(3, -1000)]).overall;
    expect(o.maxDrawdown.amount).toBe('500');
    expect(o.maxDrawdown.percent.value).toBe('50.00');
  });

  it('a fall that is deeper in both amount and percent wins', () => {
    // entry 1000, size 1 so P&L = exit - 1000
    const t = (id: number, pnl: number) =>
      trade({
        id,
        entryPrice: '1000',
        exitPrice: String(1000 + pnl),
        size: '1',
        initialStopLoss: '900',
      });
    // 1000 -> 1500 -> 1400 -> 1000 -> 1200:  peak 1500; falls 100 (6.67 %), 500 (33.33 %); max 500
    const o = base([t(1, 500), t(2, -100), t(3, -400), t(4, 200)]).overall;
    expect(o.maxDrawdown.amount).toBe('500');
    expect(o.maxDrawdown.percent.value).toBe('33.33'); // 500 / 1500
  });

  it('a starting balance of 0 cannot give a percentage while the peak is 0', () => {
    const c = computeAccountStats(
      input([trade({ id: 1, exitPrice: '90' })], { startingBalance: '0' }),
    );
    const o = c.currencies[0]!.overall;
    expect(o.maxDrawdown.amount).toBe('10');
    expect(o.maxDrawdown.percent.value).toBeNull();
    expect(o.maxDrawdown.percent.reason).toMatch(/never rose above zero/);
  });
});

describe('unusable trades are skipped and reported, never crash', () => {
  const rows = [
    trade({ id: 1 }),
    trade({ id: 2, exitPrice: null }),
    trade({ id: 3, entryPrice: 'abc' }),
    trade({ id: 4, size: '0' }),
    trade({ id: 5, closedAt: null }),
    trade({ id: 6, direction: 'sideways' }),
    trade({ id: 7, fees: '-1' }),
  ];
  const c = base(rows);

  it('counts only the usable trade and lists the rest with reasons', () => {
    expect(c.overall.tradeCount).toBe(1);
    expect(c.skipped.map((s) => s.tradeId)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(c.skipped.find((s) => s.tradeId === 2)!.reason).toMatch(/exit price/);
    expect(c.skipped.find((s) => s.tradeId === 5)!.reason).toMatch(/closed time/);
  });
});

describe('setup breakdown naming', () => {
  it('puts "(no setup)" last and uses the setup name', () => {
    const c = base([
      trade({ id: 1 }),
      trade({ id: 2, setupId: 9, setupName: 'Zebra' }),
      trade({ id: 3, setupId: 4, setupName: 'Alpha' }),
    ]);
    expect(c.bySetup.map((b) => b.label)).toEqual(['Alpha', 'Zebra', '(no setup)']);
  });
});

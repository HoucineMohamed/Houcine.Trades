import { describe, expect, it } from 'vitest';
import { computeAccountStats } from './account';
import { input, trade } from './fixtures';

/**
 * GOLDEN DATASET. Every expected number below was worked out BY HAND (arithmetic in comments),
 * not by running the code. Account: base currency USDT, starting balance 1000.
 *
 *  id  symbol    class   dir    setup     entry     exit      size      initial stop  fees
 *  1   BTCUSDT   crypto  long   Breakout  100       110       2         95            1 USDT
 *  2   ETHUSDT   crypto  short  Breakout  200       210       1         205           0.5 USDT
 *  3   AAPL      stock   long   Pullback  100       104       1         98            0
 *  4   BTCUSDT   crypto  short  (none)    50        50        3         52            0
 *  5   BTCUSDT   crypto  long   Pullback  100       97        2         96            2 USDT
 *  6   SHIBUSDT  crypto  long   (none)    0.00001   0.000012  1000000   0.000009      0.01 USDT
 *  7   BTCUSDT   crypto  long   Breakout  60000     60100     0.000001  59000         0
 *
 * (Trade 5's LIVE stop was later moved to 99; the engine must only ever use the initial stop 96.)
 */
const trades = [
  trade({
    id: 1,
    setupId: 1,
    setupName: 'Breakout',
    entryPrice: '100',
    exitPrice: '110',
    size: '2',
    initialStopLoss: '95',
    fees: '1',
  }),
  trade({
    id: 2,
    symbol: 'ETHUSDT',
    direction: 'short',
    setupId: 1,
    setupName: 'Breakout',
    entryPrice: '200',
    exitPrice: '210',
    size: '1',
    initialStopLoss: '205',
    fees: '0.5',
  }),
  trade({
    id: 3,
    symbol: 'AAPL',
    assetClass: 'stock',
    setupId: 2,
    setupName: 'Pullback',
    entryPrice: '100',
    exitPrice: '104',
    size: '1',
    initialStopLoss: '98',
  }),
  trade({
    id: 4,
    direction: 'short',
    entryPrice: '50',
    exitPrice: '50',
    size: '3',
    initialStopLoss: '52',
  }),
  trade({
    id: 5,
    setupId: 2,
    setupName: 'Pullback',
    entryPrice: '100',
    exitPrice: '97',
    size: '2',
    initialStopLoss: '96',
    fees: '2',
  }),
  trade({
    id: 6,
    symbol: 'SHIBUSDT',
    entryPrice: '0.00001',
    exitPrice: '0.000012',
    size: '1000000',
    initialStopLoss: '0.000009',
    fees: '0.01',
  }),
  trade({
    id: 7,
    setupId: 1,
    setupName: 'Breakout',
    entryPrice: '60000',
    exitPrice: '60100',
    size: '0.000001',
    initialStopLoss: '59000',
  }),
];

const stats = computeAccountStats(input(trades));
const usdt = stats.currencies[0]!;
const o = usdt.overall;

describe('golden: per-trade results', () => {
  const byId = (id: number) => usdt.tradeResults.find((r) => r.tradeId === id)!;

  it.each([
    // [id, gross, net, outcome, initial risk, gross R, net R]
    // 1: gross (110-100)x2 = 20; net 20-1 = 19; risk |100-95|x2 = 10; R 20/10 = 2; net R 19/10 = 1.9
    [1, '20', '19', 'win', '10', '2.0000', '1.9000'],
    // 2 (short): gross (200-210)x1 = -10; net -10.5; risk |200-205|x1 = 5; R -2; net R -10.5/5 = -2.1
    [2, '-10', '-10.5', 'loss', '5', '-2.0000', '-2.1000'],
    // 3: gross (104-100)x1 = 4; net 4; risk |100-98|x1 = 2; R 2; net R 2
    [3, '4', '4', 'win', '2', '2.0000', '2.0000'],
    // 4 (short): gross (50-50)x3 = 0; net 0; risk |50-52|x3 = 6; R 0
    [4, '0', '0', 'breakeven', '6', '0.0000', '0.0000'],
    // 5: gross (97-100)x2 = -6; net -6-2 = -8; risk |100-96|x2 = 8 (NOT 2: the moved stop 99 is
    //    ignored); R -6/8 = -0.75; net R -8/8 = -1
    [5, '-6', '-8', 'loss', '8', '-0.7500', '-1.0000'],
    // 6: gross (0.000012-0.00001)x1000000 = 0.000002x1000000 = 2; net 2-0.01 = 1.99;
    //    risk |0.00001-0.000009|x1000000 = 0.000001x1000000 = 1; R 2; net R 1.99
    [6, '2', '1.99', 'win', '1', '2.0000', '1.9900'],
    // 7: gross (60100-60000)x0.000001 = 100x0.000001 = 0.0001; net 0.0001;
    //    risk |60000-59000|x0.000001 = 1000x0.000001 = 0.001; R 0.0001/0.001 = 0.1
    [7, '0.0001', '0.0001', 'win', '0.001', '0.1000', '0.1000'],
  ])('trade %i', (id, gross, net, outcome, risk, grossR, netR) => {
    const r = byId(id as number);
    expect(r.grossPnl).toBe(gross);
    expect(r.netPnl).toBe(net);
    expect(r.outcome).toBe(outcome);
    expect(r.initialRisk.value).toBe(risk);
    expect(r.grossR.value).toBe(grossR);
    expect(r.netR.value).toBe(netR);
    expect(r.feesExcluded).toBe(false);
  });
});

describe('golden: overall metrics (USDT)', () => {
  it('counts', () => {
    // wins: trades 1, 3, 6, 7 = 4. losses: trades 2, 5 = 2. breakeven: trade 4 = 1.
    expect(o.tradeCount).toBe(7);
    expect([o.wins, o.losses, o.breakevens]).toEqual([4, 2, 1]);
    // win rate = 4/7 = 0.571428... = 57.14 %
    expect(o.winRatePercent.value).toBe('57.14');
  });

  it('money totals', () => {
    // gross P&L = 20 - 10 + 4 + 0 - 6 + 2 + 0.0001 = 10.0001
    expect(o.grossPnl).toBe('10.0001');
    // fees = 1 + 0.5 + 0 + 0 + 2 + 0.01 + 0 = 3.51
    expect(o.totalFees).toBe('3.51');
    // net = 19 - 10.5 + 4 + 0 - 8 + 1.99 + 0.0001 = 6.4901  (= 10.0001 - 3.51)
    expect(o.netPnl).toBe('6.4901');
    // total winners = 19 + 4 + 1.99 + 0.0001 = 24.9901 ; total losers = -10.5 - 8 = -18.5
    expect(o.totalWinners).toBe('24.9901');
    expect(o.totalLosers).toBe('-18.5');
  });

  it('averages and extremes', () => {
    // average win = 24.9901 / 4 = 6.247525 ; average loss = -18.5 / 2 = -9.25
    expect(o.averageWin.value).toBe('6.24752500');
    expect(o.averageLoss.value).toBe('-9.25000000');
    expect(o.largestWin.value).toBe('19');
    expect(o.largestLoss.value).toBe('-10.5');
  });

  it('R and expectancy', () => {
    // average gross R = (2 - 2 + 2 + 0 - 0.75 + 2 + 0.1) / 7 = 3.35 / 7 = 0.478571... -> 0.4786
    expect(o.averageR.value).toBe('0.4786');
    // expectancy R (net) = (1.9 - 2.1 + 2 + 0 - 1 + 1.99 + 0.1) / 7 = 2.89 / 7 = 0.412857... -> 0.4129
    expect(o.expectancyR.value).toBe('0.4129');
    // expectancy money = 6.4901 / 7 = 0.92715714285... -> 0.92715714
    expect(o.expectancyMoney.value).toBe('0.92715714');
    expect(o.flags).toEqual({ tradesWithExcludedFees: 0, rTradeCount: 7, netRTradeCount: 7 });
  });

  it('ratios', () => {
    // profit factor = 24.9901 / 18.5 = 1.350816... -> 1.3508
    expect(o.profitFactor.value).toBe('1.3508');
    // payoff ratio = 6.247525 / 9.25 = 0.675408... -> 0.6754
    expect(o.payoffRatio.value).toBe('0.6754');
  });

  it('streaks', () => {
    // in time order: W L W BE L W W -> longest win run = 2 (trades 6, 7); loss runs are 1 each
    expect(o.longestWinStreak).toBe(2);
    expect(o.longestLossStreak).toBe(1);
  });

  it('equity curve starts at the account balance', () => {
    // 1000 -> 1019 -> 1008.5 -> 1012.5 -> 1012.5 -> 1004.5 -> 1006.49 -> 1006.4901
    expect(usdt.equityCurve.startsFromAccountBalance).toBe(true);
    expect(usdt.equityCurve.startingEquity).toBe('1000');
    expect(usdt.equityCurve.points.map((p) => p.equity)).toEqual([
      '1019',
      '1008.5',
      '1012.5',
      '1012.5',
      '1004.5',
      '1006.49',
      '1006.4901',
    ]);
    expect(usdt.equityCurve.points.map((p) => p.tradeId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('max drawdown', () => {
    // peak 1019 (after trade 1). Falls: 10.5 (t2), 6.5 (t3, t4), 14.5 (t5), 12.51 (t6), 12.5099 (t7).
    // Deepest = 14.5 at trade 5: 14.5 / 1019 = 0.014229... = 1.42 %
    expect(o.maxDrawdown.amount).toBe('14.5');
    expect(o.maxDrawdown.percent.value).toBe('1.42');
  });

  it('small-sample warning', () => {
    expect(o.sampleSize).toMatchObject({ tradeCount: 7, minimumReliable: 30, reliable: false });
    expect(o.sampleSize.warning).toMatch(/Only 7 closed trades.*Fewer than 30/);
  });
});

describe('golden: breakdowns', () => {
  const find = (list: { label: string; stats: typeof o }[], label: string) =>
    list.find((b) => b.label === label)!.stats;

  it('by setup', () => {
    expect(usdt.bySetup.map((b) => b.label)).toEqual(['Breakout', 'Pullback', '(no setup)']);
    // Breakout = trades 1 (19), 2 (-10.5), 7 (0.0001): net 8.5001; 2 wins, 1 loss
    const breakout = find(usdt.bySetup, 'Breakout');
    expect(breakout.netPnl).toBe('8.5001');
    expect(breakout.winRatePercent.value).toBe('66.67'); // 2/3
    expect(breakout.totalWinners).toBe('19.0001');
    expect(breakout.profitFactor.value).toBe('1.8095'); // 19.0001 / 10.5 = 1.80953...
    expect(breakout.averageWin.value).toBe('9.50005000'); // 19.0001 / 2
    // from zero: 0 -> 19 -> 8.5 -> 8.5001 ; peak 19, fall 10.5 ; no percent (no balance)
    expect(breakout.maxDrawdown.amount).toBe('10.5');
    expect(breakout.maxDrawdown.percent.value).toBeNull();
    expect(breakout.maxDrawdown.percent.reason).toMatch(/no starting balance/);
    // Pullback = trades 3 (4), 5 (-8): net -4; 1 win 1 loss; PF 4/8 = 0.5; drawdown 4 -> -4 = 8
    const pullback = find(usdt.bySetup, 'Pullback');
    expect(pullback.netPnl).toBe('-4');
    expect(pullback.winRatePercent.value).toBe('50.00');
    expect(pullback.profitFactor.value).toBe('0.5000');
    expect(pullback.payoffRatio.value).toBe('0.5000');
    expect(pullback.maxDrawdown.amount).toBe('8');
    // (no setup) = trades 4 (0), 6 (1.99): net 1.99; 1 win, 1 breakeven, no losses
    const none = find(usdt.bySetup, '(no setup)');
    expect(none.netPnl).toBe('1.99');
    expect([none.wins, none.losses, none.breakevens]).toEqual([1, 0, 1]);
    expect(none.profitFactor.value).toBeNull();
    expect(none.maxDrawdown.amount).toBe('0');
  });

  it('by symbol', () => {
    expect(usdt.bySymbol.map((b) => b.label)).toEqual(['AAPL', 'BTCUSDT', 'ETHUSDT', 'SHIBUSDT']);
    // BTCUSDT = trades 1, 4, 5, 7: 19 + 0 - 8 + 0.0001 = 11.0001
    expect(find(usdt.bySymbol, 'BTCUSDT').netPnl).toBe('11.0001');
    expect(find(usdt.bySymbol, 'BTCUSDT').tradeCount).toBe(4);
    expect(find(usdt.bySymbol, 'AAPL').netPnl).toBe('4');
    expect(find(usdt.bySymbol, 'ETHUSDT').netPnl).toBe('-10.5');
    expect(find(usdt.bySymbol, 'SHIBUSDT').netPnl).toBe('1.99');
  });

  it('by direction', () => {
    expect(usdt.byDirection.map((b) => b.label)).toEqual(['long', 'short']);
    // long = trades 1, 3, 5, 6, 7: 19 + 4 - 8 + 1.99 + 0.0001 = 16.9901 ; 4 wins 1 loss = 80 %
    const long = find(usdt.byDirection, 'long');
    expect(long.netPnl).toBe('16.9901');
    expect(long.winRatePercent.value).toBe('80.00');
    // short = trades 2 (-10.5), 4 (0): net -10.5 ; 0 wins, 1 loss, 1 breakeven
    const short = find(usdt.byDirection, 'short');
    expect(short.netPnl).toBe('-10.5');
    expect(short.winRatePercent.value).toBe('0.00');
    expect(short.averageWin.value).toBeNull();
    expect(short.profitFactor.value).toBe('0.0000'); // 0 / 10.5
  });

  it('by asset class', () => {
    expect(usdt.byAssetClass.map((b) => b.label)).toEqual(['crypto', 'stock']);
    // stock = trade 3 only (4); crypto = the other six: 6.4901 - 4 = 2.4901
    expect(find(usdt.byAssetClass, 'stock').netPnl).toBe('4');
    expect(find(usdt.byAssetClass, 'crypto').netPnl).toBe('2.4901');
    expect(find(usdt.byAssetClass, 'crypto').tradeCount).toBe(6);
  });
});

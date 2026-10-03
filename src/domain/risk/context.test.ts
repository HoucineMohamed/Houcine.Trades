import { describe, expect, it } from 'vitest';
import { trade as statsTrade } from '../stats/fixtures';
import { buildContext, event, openTrade, pnlTrade } from './fixtures';
import { RISK_DEFAULTS } from './settings';

const T = (iso: string) => iso; // readability: all times are canonical UTC text
const kinds = (c: { halts: { kind: string }[] }) => c.halts.map((h) => h.kind).sort();

describe('equity (stats-engine figures, base currency only, realised only)', () => {
  it('equity = starting balance + net realised P&L; peak and day figures follow', () => {
    // start 10000 ; +500 on 9 March ; -100 today -> equity 10400 ; day-start equity 10500
    const c = buildContext({
      trades: [
        pnlTrade(1, '500', T('2026-03-09T10:00:00.000Z')),
        pnlTrade(2, '-100', T('2026-03-10T10:00:00.000Z')),
      ],
    });
    expect(c.equity).toBe('10400');
    expect(c.dayStartEquity).toBe('10500');
    expect(c.todayNetPnl).toBe('-100');
    expect(c.peakEquity).toBe('10500');
    expect(c.fallFromPeak).toBe('100');
    expect(c.baselineEquity).toBe('10000');
    expect(c.dayStart).toBe('2026-03-10T00:00:00.000Z');
    expect(c.halts).toEqual([]);
  });

  it('no trades: equity is the starting balance', () => {
    const c = buildContext({});
    expect(c).toMatchObject({
      equity: '10000',
      dayStartEquity: '10000',
      todayNetPnl: '0',
      peakEquity: '10000',
      fallFromPeak: '0',
      equityProblem: null,
    });
  });

  it('only base-currency trades count (another currency is not converted or added)', () => {
    const eur = statsTrade({
      id: 9,
      quoteCurrency: 'EUR',
      feesCurrency: 'EUR',
      exitPrice: '200',
      closedAt: '2026-03-10T10:00:00.000Z',
    });
    const c = buildContext({ trades: [eur] });
    expect(c.equity).toBe('10000');
    expect(c.todayNetPnl).toBe('0');
  });

  it('open trades never change equity (no unrealised P&L)', () => {
    const c = buildContext({ openTrades: [openTrade({ tradeId: 1 })] });
    expect(c.equity).toBe('10000');
    expect(c.openTrades).toHaveLength(1);
  });
});

describe('fail closed: equity that cannot be verified', () => {
  it('a closed trade the stats engine had to skip', () => {
    const c = buildContext({ trades: [statsTrade({ id: 7, exitPrice: null })] });
    expect(c.equity).toBeNull();
    expect(c.equityProblem).toMatch(/#7/);
  });

  it('a missing starting balance', () => {
    const c = buildContext({ startingBalance: '' });
    expect(c.equity).toBeNull();
    expect(c.equityProblem).toMatch(/starting balance/);
  });

  it('equity of zero or below', () => {
    // long 20000 -> 10000 loses 10000 = the whole balance
    const zero = buildContext({
      trades: [
        statsTrade({ id: 1, entryPrice: '20000', exitPrice: '10000', initialStopLoss: '19000' }),
      ],
    });
    expect(zero.equity).toBeNull();
    expect(zero.equityProblem).toMatch(/zero or negative/);
    const negative = buildContext({
      trades: [
        statsTrade({ id: 1, entryPrice: '30000', exitPrice: '10000', initialStopLoss: '29000' }),
      ],
    });
    expect(negative.equityProblem).toMatch(/zero or negative/);
  });

  it('an unknown account', () => {
    const c = buildContext({ noAccount: true });
    expect(c.accountKnown).toBe(false);
    expect(c.equity).toBeNull();
    expect(c.equityProblem).toMatch(/does not exist/);
  });

  it('a corrupt drawdown baseline in a reset event', () => {
    const c = buildContext({
      events: [
        event(1, 'reset', 'drawdown', T('2026-03-05T10:00:00.000Z'), { baselineEquity: 'abc' }),
      ],
    });
    expect(c.equity).toBeNull();
    expect(c.equityProblem).toMatch(/baseline is corrupt/);
  });

  it('closed trades with foreign-currency fees are counted for the warning', () => {
    const c = buildContext({
      trades: [
        statsTrade({ id: 1, fees: '5', feesCurrency: 'BNB', closedAt: '2026-03-01T10:00:00.000Z' }),
      ],
    });
    expect(c.tradesWithExcludedFees).toBe(1);
    expect(c.equity).not.toBeNull(); // a warning, not a refusal
  });
});

describe('corrupt or missing settings', () => {
  it.each([
    ['missing', null, /no risk settings/],
    ['unreadable', '{not json', /not readable/],
    [
      'above a hard ceiling',
      JSON.stringify({ ...RISK_DEFAULTS, maxRiskPerTradePercent: '5' }),
      /ceiling/,
    ],
    ['an unknown field', JSON.stringify({ ...RISK_DEFAULTS, extra: 1 }), /unknown/],
  ])('settings %s: settings are null with a reason', (_name, json, reason) => {
    const c = buildContext({ settingsJson: json });
    expect(c.settings).toBeNull();
    expect(c.settingsProblem).toMatch(reason);
  });

  it('corrupt pending changes also fail closed', () => {
    const c = buildContext({ pendingJson: '{oops' });
    expect(c.settings).toBeNull();
    expect(c.settingsProblem).toMatch(/pending/);
  });

  it('a manual halt still stands when settings are corrupt', () => {
    const c = buildContext({
      settingsJson: '{bad',
      events: [event(1, 'halt', 'manual', T('2026-03-10T09:00:00.000Z'), { reason: 'x' })],
    });
    expect(kinds(c)).toEqual(['manual']);
  });
});

describe('daily-loss halt: 3 % of the equity at the start of the UTC day', () => {
  // 500 profit yesterday -> day-start equity 10500 -> limit 3 % = 315
  const yesterday = pnlTrade(1, '500', T('2026-03-09T10:00:00.000Z'));

  it('one cent under the limit: not halted', () => {
    // loss 314.99 -> 31499 < 10500 x 3 = 31500
    const c = buildContext({
      trades: [yesterday, pnlTrade(2, '-314.99', T('2026-03-10T10:00:00.000Z'))],
    });
    expect(c.dayStartEquity).toBe('10500');
    expect(kinds(c)).toEqual([]);
  });

  it('exactly at the limit: halted (the limit is REACHED)', () => {
    const c = buildContext({
      trades: [yesterday, pnlTrade(2, '-315', T('2026-03-10T10:00:00.000Z'))],
    });
    expect(kinds(c)).toEqual(['daily_loss']);
    expect(c.halts[0]!.clearsAt).toBe('2026-03-11T00:00:00.000Z');
    expect(c.halts[0]!.message).toMatch(/3%/);
    expect(c.halts[0]!.resetAllowedNow).toBe(false); // no manual reset for a daily halt
  });

  it('a winning day never halts', () => {
    expect(
      kinds(
        buildContext({ trades: [yesterday, pnlTrade(2, '1000', T('2026-03-10T10:00:00.000Z'))] }),
      ),
    ).toEqual([]);
  });

  it('wins and losses net out, in any order', () => {
    const a = buildContext({
      trades: [
        yesterday,
        pnlTrade(2, '100', T('2026-03-10T09:00:00.000Z')),
        pnlTrade(3, '-415', T('2026-03-10T10:00:00.000Z')),
      ],
    });
    const b = buildContext({
      trades: [
        yesterday,
        pnlTrade(2, '-415', T('2026-03-10T09:00:00.000Z')),
        pnlTrade(3, '100', T('2026-03-10T10:00:00.000Z')),
      ],
    });
    expect(a.todayNetPnl).toBe('-315');
    expect(kinds(a)).toEqual(['daily_loss']);
    expect(kinds(b)).toEqual(['daily_loss']);
  });

  it('clears by itself at the next UTC day (1 ms before / at midnight)', () => {
    const trades = [yesterday, pnlTrade(2, '-315', T('2026-03-10T10:00:00.000Z'))];
    expect(kinds(buildContext({ trades, now: '2026-03-10T23:59:59.999Z' }))).toEqual([
      'daily_loss',
    ]);
    const next = buildContext({ trades, now: '2026-03-11T00:00:00.000Z' });
    expect(kinds(next)).toEqual([]);
    // the new day starts from the new equity: 10500 - 315 = 10185
    expect(next.dayStartEquity).toBe('10185');
    expect(next.todayNetPnl).toBe('0');
  });

  it('is derived from the data: no stored state is needed (the same inputs always halt)', () => {
    const input = { trades: [yesterday, pnlTrade(2, '-315', T('2026-03-10T10:00:00.000Z'))] };
    expect(buildContext(input).halts).toEqual(buildContext(input).halts);
  });

  it('asks the data layer to log the halt once per day', () => {
    const trades = [yesterday, pnlTrade(2, '-315', T('2026-03-10T10:00:00.000Z'))];
    const fresh = buildContext({ trades });
    expect(fresh.newHaltEvents).toMatchObject([{ kind: 'daily_loss', day: '2026-03-10' }]);
    const logged = buildContext({
      trades,
      events: [
        event(1, 'halt', 'daily_loss', T('2026-03-10T11:00:00.000Z'), { day: '2026-03-10' }),
      ],
    });
    expect(logged.newHaltEvents).toEqual([]);
    expect(kinds(logged)).toEqual(['daily_loss']);
  });
});

describe('backdated losses still count toward today (closed time OR recorded time)', () => {
  it('a loss closed "yesterday" but recorded today counts today and halts', () => {
    // no other trades: day-start equity 10000, limit 300. Loss 400, closed 9 March, recorded 10 March.
    const c = buildContext({
      trades: [pnlTrade(1, '-400', T('2026-03-09T12:00:00.000Z'))],
      recorded: { 1: T('2026-03-10T14:00:00.000Z') },
    });
    expect(c.todayNetPnl).toBe('-400');
    expect(c.dayStartEquity).toBe('10000'); // it was not in the books at the start of today
    expect(c.equity).toBe('9600');
    expect(kinds(c)).toEqual(['daily_loss']);
  });

  it('control: the same loss recorded yesterday does not count today', () => {
    const c = buildContext({ trades: [pnlTrade(1, '-400', T('2026-03-09T12:00:00.000Z'))] });
    expect(c.todayNetPnl).toBe('0');
    expect(c.dayStartEquity).toBe('9600');
    expect(kinds(c)).toEqual([]);
  });

  it('closed time today counts even if the recorded time is earlier', () => {
    const c = buildContext({
      trades: [pnlTrade(1, '-400', T('2026-03-10T08:00:00.000Z'))],
      recorded: { 1: T('2026-03-09T23:00:00.000Z') },
    });
    expect(c.todayNetPnl).toBe('-400');
    expect(kinds(c)).toEqual(['daily_loss']);
  });

  it('the day boundary is UTC midnight, inclusive at the start', () => {
    const at = (iso: string) => buildContext({ trades: [pnlTrade(1, '-400', iso)] });
    expect(at('2026-03-10T00:00:00.000Z').todayNetPnl).toBe('-400'); // first instant of the day
    expect(at('2026-03-09T23:59:59.999Z').todayNetPnl).toBe('0'); // last instant of yesterday
  });

  it("a backdated win recorded today nets against today's losses", () => {
    const c = buildContext({
      trades: [
        pnlTrade(1, '-400', T('2026-03-10T08:00:00.000Z')),
        pnlTrade(2, '150', T('2026-03-09T12:00:00.000Z')),
      ],
      recorded: { 2: T('2026-03-10T09:00:00.000Z') },
    });
    expect(c.todayNetPnl).toBe('-250'); // -400 + 150: both are "today" by the rule
  });
});

describe('drawdown halt: 10 % from peak equity, only a manual reset lifts it', () => {
  // start 10000 ; +2000 on 1 March -> peak 12000 ; limit 10 % = 1200
  const win = pnlTrade(1, '2000', T('2026-03-01T10:00:00.000Z'));
  const NOW_AFTER = '2026-03-10T15:00:00.000Z';

  it('one cent under 10 %: not halted', () => {
    // equity 10800.01: fall 1199.99 -> 119999 < 12000 x 10 = 120000
    const c = buildContext({
      trades: [win, pnlTrade(2, '-1199.99', T('2026-03-02T09:00:00.000Z'))],
      now: NOW_AFTER,
    });
    expect(kinds(c)).toEqual([]);
    expect(c.peakEquity).toBe('12000');
    expect(c.fallFromPeak).toBe('1199.99');
  });

  it('exactly 10 %: halted (the limit is REACHED)', () => {
    const c = buildContext({
      trades: [win, pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z'))],
      now: NOW_AFTER,
    });
    expect(kinds(c)).toEqual(['drawdown']);
    expect(c.halts[0]!.since).toBe('2026-03-02T09:00:00.000Z');
  });

  it('recovering afterwards does NOT lift it (the breach is part of the history)', () => {
    const c = buildContext({
      trades: [
        win,
        pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z')),
        pnlTrade(3, '1000', T('2026-03-02T10:00:00.000Z')),
      ],
      now: NOW_AFTER,
    });
    expect(c.equity).toBe('11800');
    expect(kinds(c)).toEqual(['drawdown']);
  });

  it('the halt began when the breaching trade was RECORDED, not when it claims to have closed', () => {
    const c = buildContext({
      trades: [win, pnlTrade(2, '-1200', T('2026-03-01T12:00:00.000Z'))],
      recorded: { 2: T('2026-03-02T09:00:00.000Z') },
      now: NOW_AFTER,
    });
    expect(c.halts[0]!.since).toBe('2026-03-02T09:00:00.000Z');
  });

  it('asks the data layer to latch it, with the begin time', () => {
    const c = buildContext({
      trades: [win, pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z'))],
      now: NOW_AFTER,
    });
    expect(c.newHaltEvents).toMatchObject([
      { kind: 'drawdown', beganAt: '2026-03-02T09:00:00.000Z' },
    ]);
  });

  describe('manual reset is possible only 24 hours after the halt began', () => {
    const halted = (now: string) =>
      buildContext({ trades: [win, pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z'))], now })
        .halts[0]!;

    it('before 24 h (1 ms early): not allowed, 1 ms remaining', () => {
      const h = halted('2026-03-03T08:59:59.999Z');
      expect(h).toMatchObject({
        resetAllowedNow: false,
        resetRemainingMs: 1,
        resetAvailableAt: '2026-03-03T09:00:00.000Z',
      });
    });

    it('exactly at 24 h: allowed', () => {
      expect(halted('2026-03-03T09:00:00.000Z')).toMatchObject({
        resetAllowedNow: true,
        resetRemainingMs: 0,
      });
    });

    it('after 24 h: allowed', () => {
      expect(halted('2026-03-03T09:00:00.001Z')).toMatchObject({
        resetAllowedNow: true,
        resetRemainingMs: 0,
      });
      expect(halted('2026-03-09T00:00:00.000Z').resetAllowedNow).toBe(true);
    });

    it('right after the halt: the full 24 hours remain', () => {
      expect(halted('2026-03-02T09:00:00.000Z')).toMatchObject({
        resetAllowedNow: false,
        resetRemainingMs: 86_400_000,
      });
    });
  });

  describe('a latched halt survives everything but a reset', () => {
    const latch = event(1, 'halt', 'drawdown', T('2026-03-02T09:05:00.000Z'), {
      beganAt: '2026-03-02T09:00:00.000Z',
    });

    it('stands even when the data no longer shows the breach (a restart can not lose it)', () => {
      const c = buildContext({ events: [latch], now: NOW_AFTER });
      expect(kinds(c)).toEqual(['drawdown']);
      expect(c.halts[0]!.since).toBe('2026-03-02T09:00:00.000Z');
      expect(c.newHaltEvents).toEqual([]);
    });

    it('stands when the limit is loosened later', () => {
      const looser = JSON.stringify({ ...RISK_DEFAULTS, maxDrawdownPercent: '20' });
      const c = buildContext({ events: [latch], settingsJson: looser, now: NOW_AFTER });
      expect(kinds(c)).toEqual(['drawdown']);
    });

    it('a breach is still detected with the tighter stored limit while a loosening is pending-but-due', () => {
      const pending = JSON.stringify({
        maxDrawdownPercent: {
          value: '15',
          requestedAt: '2026-03-08T00:00:00.000Z',
          effectiveAt: '2026-03-09T00:00:00.000Z',
        },
      });
      const c = buildContext({
        trades: [win, pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z'))],
        pendingJson: pending,
        now: NOW_AFTER,
      });
      expect(c.settings!.maxDrawdownPercent).toBe('15'); // the loosening has taken effect...
      expect(kinds(c)).toEqual(['drawdown']); // ...but cannot hide a breach of the old limit
      expect(c.newHaltEvents[0]).toMatchObject({ kind: 'drawdown' });
    });

    it('is lifted only by a LATER reset event; the same reset before the halt does nothing', () => {
      const reset = event(2, 'reset', 'drawdown', T('2026-03-04T10:00:00.000Z'), {
        baselineEquity: '10000',
      });
      expect(kinds(buildContext({ events: [latch, reset], now: NOW_AFTER }))).toEqual([]);
      const resetFirst = event(0, 'reset', 'drawdown', T('2026-03-01T10:00:00.000Z'), {
        baselineEquity: '10000',
      });
      expect(kinds(buildContext({ events: [resetFirst, latch], now: NOW_AFTER }))).toEqual([
        'drawdown',
      ]);
    });
  });

  describe('after a reset, drawdown is measured from the new baseline', () => {
    const trades = [
      win,
      pnlTrade(2, '-1200', T('2026-03-02T09:00:00.000Z')),
      pnlTrade(3, '1000', T('2026-03-02T10:00:00.000Z')),
    ]; // equity 11800
    const events = [
      event(1, 'halt', 'drawdown', T('2026-03-02T09:05:00.000Z'), {
        beganAt: '2026-03-02T09:00:00.000Z',
      }),
      event(2, 'reset', 'drawdown', T('2026-03-04T10:00:00.000Z'), { baselineEquity: '11800' }),
    ];

    it('the old breach no longer halts and the baseline is the equity at the reset', () => {
      const c = buildContext({ trades, events, now: '2026-03-05T12:00:00.000Z' });
      expect(kinds(c)).toEqual([]);
      expect(c.baselineEquity).toBe('11800');
      expect(c.peakEquity).toBe('11800');
      expect(c.fallFromPeak).toBe('0');
    });

    it('a new fall of exactly 10 % from the baseline halts again; one cent less does not', () => {
      const later = (pnl: string) =>
        buildContext({
          trades: [...trades, pnlTrade(4, pnl, T('2026-03-05T10:00:00.000Z'))],
          events,
          now: '2026-03-07T12:00:00.000Z',
        });
      // 10 % of 11800 = 1180
      expect(kinds(later('-1179.99'))).toEqual([]);
      const halted = later('-1180');
      expect(kinds(halted)).toEqual(['drawdown']);
      expect(halted.halts[0]!.since).toBe('2026-03-05T10:00:00.000Z');
    });

    it('only trades recorded AFTER the reset count toward the new baseline', () => {
      // a trade recorded before the reset (even closed later by its own clock) is inside the baseline already
      const c = buildContext({
        trades: [...trades, pnlTrade(4, '-1180', T('2026-03-06T10:00:00.000Z'))],
        recorded: { 4: T('2026-03-04T09:00:00.000Z') },
        events,
        now: '2026-03-07T12:00:00.000Z',
      });
      expect(kinds(c)).toEqual([]);
    });
  });
});

describe('manual halt', () => {
  const halt = event(1, 'halt', 'manual', T('2026-03-10T14:00:00.000Z'), { reason: 'I am tired' });

  it('halts at once and can be reset immediately', () => {
    const c = buildContext({ events: [halt] });
    expect(c.halts).toHaveLength(1);
    expect(c.halts[0]).toMatchObject({
      kind: 'manual',
      resetAllowedNow: true,
      resetRemainingMs: 0,
      since: '2026-03-10T14:00:00.000Z',
    });
    expect(c.halts[0]!.message).toContain('I am tired');
  });

  it('is cleared only by a later manual reset, not by a drawdown reset or the next day', () => {
    const nextDay = buildContext({ events: [halt], now: '2026-04-20T00:00:00.000Z' });
    expect(kinds(nextDay)).toEqual(['manual']);
    const wrongKind = event(2, 'reset', 'drawdown', T('2026-03-10T15:00:00.000Z'), {
      baselineEquity: '10000',
    });
    expect(kinds(buildContext({ events: [halt, wrongKind] }))).toEqual(['manual']);
    const reset = event(2, 'reset', 'manual', T('2026-03-10T15:00:00.000Z'), { reason: 'rested' });
    expect(kinds(buildContext({ events: [halt, reset] }))).toEqual([]);
  });

  it('a new manual halt after a reset halts again', () => {
    const events = [
      halt,
      event(2, 'reset', 'manual', T('2026-03-10T15:00:00.000Z')),
      event(3, 'halt', 'manual', T('2026-03-10T16:00:00.000Z'), { reason: 'again' }),
    ];
    expect(kinds(buildContext({ events }))).toEqual(['manual']);
  });
});

describe('several halts at once, and restart safety', () => {
  const trades = [pnlTrade(1, '-1500', T('2026-03-10T10:00:00.000Z'))]; // 15 % loss today
  const events = [event(1, 'halt', 'manual', T('2026-03-10T11:00:00.000Z'), { reason: 'stop' })];

  it('daily-loss, drawdown and manual halts can all be active together', () => {
    expect(kinds(buildContext({ trades, events }))).toEqual(['daily_loss', 'drawdown', 'manual']);
  });

  it('the same facts always give the same result, even after a JSON round trip (a restart)', () => {
    const first = buildContext({ trades, events });
    const restarted = buildContext({
      trades: JSON.parse(JSON.stringify(trades)),
      events: JSON.parse(JSON.stringify(events)),
    });
    expect(restarted).toEqual(first);
  });

  it('event order is taken from the event id, not from the order they are passed in', () => {
    const halt = event(1, 'halt', 'manual', T('2026-03-10T11:00:00.000Z'));
    const reset = event(2, 'reset', 'manual', T('2026-03-10T12:00:00.000Z'));
    expect(kinds(buildContext({ events: [reset, halt] }))).toEqual([]);
  });
});

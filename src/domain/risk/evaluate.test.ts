import { describe, expect, it } from 'vitest';
import { evaluatePlan } from './evaluate';
import { ctx, openTrade, plan, withSettings } from './fixtures';
import type { ActiveHalt } from './context';
import type { ViolationCode } from './types';

const codes = (v: ReturnType<typeof evaluatePlan>) => v.violations.map((x) => x.code).sort();

const halt = (kind: ActiveHalt['kind']): ActiveHalt => ({
  kind,
  message: `halted: ${kind}`,
  since: null,
  clearsAt: null,
  resetAllowedNow: false,
  resetAvailableAt: null,
  resetRemainingMs: null,
});

describe('golden approvals (hand-computed)', () => {
  it('long: entry 100, stop 95, size 20 risks exactly 1 % of 10000 and is approved', () => {
    // risk = |100 - 95| x 20 = 100 ; limit = 10000 x 1 % = 100 -> exactly at the limit: allowed
    // open risk after = 0 + 100 = 100 (1 %) ; limit 3 % = 300 ; reward = 115 - 100 = 15 -> 15 / 5 = 3
    const v = evaluatePlan(plan(), ctx());
    expect(v.approved).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.numbers).toMatchObject({
      equity: '10000',
      riskAmount: '100',
      riskPercent: '1.0000',
      riskLimitAmount: '100',
      openRiskBefore: '0',
      openRiskAfter: '100',
      openRiskAfterPercent: '1.0000',
      openRiskLimitAmount: '300',
      openTradesBefore: 0,
      openTradesAfter: 1,
      maxOpenTrades: 3,
      rewardToRisk: '3.0000',
    });
  });

  it('short: entry 200, stop 210, target 170, size 10 risks exactly 100', () => {
    // risk = |200 - 210| x 10 = 100 ; reward = 30 -> 30 / 10 = 3
    const v = evaluatePlan(
      plan({ direction: 'short', entry: '200', stop: '210', target: '170', size: '10' }),
      ctx(),
    );
    expect(v.approved).toBe(true);
    expect(v.numbers).toMatchObject({ riskAmount: '100', rewardToRisk: '3.0000' });
  });
});

describe('boundaries: exactly at a limit passes, one smallest unit over fails', () => {
  it('risk per trade: 20 passes, 20.000000000000000001 (one 18-decimal unit over) fails', () => {
    expect(evaluatePlan(plan({ size: '20' }), ctx()).approved).toBe(true);
    // risk = 5 x 20.000000000000000001 = 100.000000000000000005 > 100
    const over = evaluatePlan(plan({ size: '20.000000000000000001' }), ctx());
    expect(over.approved).toBe(false);
    expect(codes(over)).toEqual(['MAX_RISK_PER_TRADE']);
  });

  it('total open risk: 300 passes, 300.01 fails (per-trade limit raised to 2 % so only this fires)', () => {
    const s = withSettings({ maxRiskPerTradePercent: '2' });
    const open = [
      openTrade({ tradeId: 1 }), // risk |100-95| x 20 = 100
      openTrade({ tradeId: 2, entryPrice: '50', initialStopLoss: '49', size: '100' }), // 1 x 100 = 100
    ];
    // plan risk 100 -> after = 300 = 3 % of 10000 -> allowed
    expect(
      evaluatePlan(plan({ size: '20' }), ctx({ settings: s, openTrades: open })).approved,
    ).toBe(true);
    // plan size 20.002 -> risk 100.01 -> after 300.01 > 300
    const over = evaluatePlan(plan({ size: '20.002' }), ctx({ settings: s, openTrades: open }));
    expect(codes(over)).toEqual(['MAX_OPEN_RISK']);
    expect(over.numbers.openRiskAfter).toBe('300.01');
  });

  it('number of open trades: 2 open + this one = 3 passes, 3 open + this one = 4 fails', () => {
    const tiny = (id: number) => openTrade({ tradeId: id, size: '1' }); // risk 5 each
    expect(evaluatePlan(plan(), ctx({ openTrades: [tiny(1), tiny(2)] })).approved).toBe(true);
    const four = evaluatePlan(plan(), ctx({ openTrades: [tiny(1), tiny(2), tiny(3)] }));
    expect(codes(four)).toEqual(['MAX_OPEN_TRADES']);
    expect(four.numbers).toMatchObject({
      openTradesBefore: 3,
      openTradesAfter: 4,
      maxOpenTrades: 3,
    });
  });

  it('minimum reward-to-risk is a WARNING: exactly 1.5 is fine, just under warns, never refuses', () => {
    // distance 5 -> reward 7.5 is exactly 1.5 R
    expect(evaluatePlan(plan({ target: '107.5' }), ctx()).warnings).toEqual([]);
    const under = evaluatePlan(plan({ target: '107.4999' }), ctx());
    expect(under.approved).toBe(true);
    expect(under.warnings.map((w) => w.code)).toEqual(['LOW_REWARD_TO_RISK']);
    expect(under.numbers.rewardToRisk).toBe('1.4999'); // rounded DOWN, never overstated
  });
});

describe('all violations are listed, not only the first', () => {
  it('lists every problem together', () => {
    const v = evaluatePlan(
      plan({ stop: '105', quoteCurrency: 'EUR' }), // long with stop above entry, wrong currency
      ctx({
        halts: [halt('manual')],
        openTrades: [
          openTrade({ tradeId: 1, size: '1' }),
          openTrade({ tradeId: 2, size: '1' }),
          openTrade({ tradeId: 3, size: '1' }),
        ],
      }),
    );
    expect(v.approved).toBe(false);
    expect(codes(v)).toEqual(
      ['CURRENCY_MISMATCH', 'HALTED_MANUAL', 'MAX_OPEN_TRADES', 'STOP_WRONG_SIDE'].sort(),
    );
  });

  it('each halt kind has its own code', () => {
    const expected: [ActiveHalt['kind'], ViolationCode][] = [
      ['daily_loss', 'HALTED_DAILY_LOSS'],
      ['drawdown', 'HALTED_DRAWDOWN'],
      ['manual', 'HALTED_MANUAL'],
    ];
    for (const [kind, code] of expected) {
      expect(codes(evaluatePlan(plan(), ctx({ halts: [halt(kind)] })))).toEqual([code]);
    }
    const all = evaluatePlan(
      plan(),
      ctx({ halts: [halt('daily_loss'), halt('drawdown'), halt('manual')] }),
    );
    expect(codes(all)).toEqual(['HALTED_DAILY_LOSS', 'HALTED_DRAWDOWN', 'HALTED_MANUAL']);
  });

  it('every message is plain text', () => {
    const v = evaluatePlan(plan({ stop: null }), ctx());
    for (const x of v.violations) expect(x.message.length).toBeGreaterThan(10);
  });
});

describe('fail closed: missing, invalid or ambiguous data is refused', () => {
  it.each([null, '', '   ', 'abc', '0', '-1', '1e5'])('stop-loss %j', (stop) => {
    const v = evaluatePlan(plan({ stop }), ctx());
    expect(v.approved).toBe(false);
    expect(codes(v)).toContain('NO_STOP_LOSS');
  });

  it.each([null, '', 'abc', '0', '-3'])('entry %j and size %j are invalid plans', (bad) => {
    expect(codes(evaluatePlan(plan({ entry: bad }), ctx()))).toContain('INVALID_PLAN');
    expect(codes(evaluatePlan(plan({ size: bad }), ctx()))).toContain('INVALID_PLAN');
  });

  it('a stop equal to the entry is on the wrong side', () => {
    expect(codes(evaluatePlan(plan({ stop: '100' }), ctx()))).toEqual(['STOP_WRONG_SIDE']);
  });

  it('an unknown direction is refused', () => {
    expect(codes(evaluatePlan(plan({ direction: 'sideways' }), ctx()))).toContain('INVALID_PLAN');
  });

  it('a target on the wrong side is refused', () => {
    expect(codes(evaluatePlan(plan({ target: '90' }), ctx()))).toEqual(['TARGET_WRONG_SIDE']);
    expect(
      codes(
        evaluatePlan(
          plan({ direction: 'short', entry: '200', stop: '210', target: '210', size: '10' }),
          ctx(),
        ),
      ),
    ).toEqual(['TARGET_WRONG_SIDE']);
  });

  it('missing equity is refused with the reason', () => {
    const v = evaluatePlan(
      plan(),
      ctx({ equity: null, equityProblem: 'The account starting balance is missing.' }),
    );
    expect(codes(v)).toEqual(['EQUITY_UNAVAILABLE']);
    expect(v.violations[0]!.message).toContain('starting balance is missing');
  });

  it('a currency mismatch is refused with the documented reason (no conversion)', () => {
    const v = evaluatePlan(plan({ quoteCurrency: 'EUR' }), ctx());
    expect(codes(v)).toEqual(['CURRENCY_MISMATCH']);
    expect(v.violations[0]!.message).toContain(
      'risk cannot be verified without currency conversion',
    );
    expect(v.numbers.riskPercent).toBeNull();
  });

  it('an unknown account is refused', () => {
    const v = evaluatePlan(
      plan(),
      ctx({
        accountKnown: false,
        baseCurrency: null,
        equity: null,
        settings: null,
        settingsProblem: 'x',
      }),
    );
    expect(codes(v)).toContain('ACCOUNT_UNKNOWN');
    expect(v.approved).toBe(false);
  });

  it('missing or corrupt settings are refused', () => {
    const v = evaluatePlan(
      plan(),
      ctx({ settings: null, settingsProblem: 'the stored risk settings are not readable' }),
    );
    expect(codes(v)).toEqual(['SETTINGS_INVALID']);
    expect(v.violations[0]!.message).toContain('not readable');
  });

  it('an open trade whose risk cannot be verified blocks approval', () => {
    const otherCurrency = evaluatePlan(
      plan(),
      ctx({ openTrades: [openTrade({ tradeId: 7, quoteCurrency: 'EUR' })] }),
    );
    expect(codes(otherCurrency)).toEqual(['OPEN_RISK_UNVERIFIABLE']);
    expect(otherCurrency.violations[0]!.message).toContain('#7');
    const noStop = evaluatePlan(
      plan(),
      ctx({ openTrades: [openTrade({ tradeId: 8, initialStopLoss: null })] }),
    );
    expect(codes(noStop)).toEqual(['OPEN_RISK_UNVERIFIABLE']);
    const noSize = evaluatePlan(
      plan(),
      ctx({ openTrades: [openTrade({ tradeId: 9, size: 'abc' })] }),
    );
    expect(codes(noSize)).toEqual(['OPEN_RISK_UNVERIFIABLE']);
  });

  it('never approves by default: a context with nothing known is refused', () => {
    const v = evaluatePlan(
      {
        symbol: '',
        direction: '',
        entry: null,
        stop: null,
        target: null,
        size: null,
        quoteCurrency: '',
      },
      ctx({ equity: null, settings: null, accountKnown: false, baseCurrency: null }),
    );
    expect(v.approved).toBe(false);
    expect(v.violations.length).toBeGreaterThan(3);
  });
});

describe('warnings', () => {
  it('no target: reward-to-risk cannot be checked (warning only)', () => {
    const v = evaluatePlan(plan({ target: null }), ctx());
    expect(v.approved).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(['NO_TARGET']);
  });

  it('foreign-currency fees in closed trades: equity may be overstated (warning only)', () => {
    const v = evaluatePlan(plan(), ctx({ tradesWithExcludedFees: 2 }));
    expect(v.approved).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(['EQUITY_MAY_BE_OVERSTATED']);
    expect(v.warnings[0]!.message).toContain('2 closed trade(s)');
  });
});

describe('open risk uses the INITIAL stop (a moved stop never frees room)', () => {
  it('risk of an open trade = |entry - initial stop| x size', () => {
    // open trade entry 100, initial stop 90, size 10 -> risk 100 (even if the live stop is now 99)
    const v = evaluatePlan(
      plan({ size: '20' }),
      ctx({ openTrades: [openTrade({ tradeId: 1, initialStopLoss: '90', size: '10' })] }),
    );
    expect(v.numbers.openRiskBefore).toBe('100');
    expect(v.numbers.openRiskAfter).toBe('200');
  });
});

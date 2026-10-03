import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import {
  assertTransition,
  buildNewTrade,
  cancelTrade,
  canTransition,
  closeTrade,
  editableFields,
  editTrade,
  openTrade,
} from './lifecycle';
import { STATUSES, type TradeFields, type TradeStatus } from './types';
import { findTradeIssues } from './validation';

const longInput = {
  accountId: 1,
  symbol: 'btcusdt',
  assetClass: 'crypto',
  direction: 'long',
  plannedEntry: '100',
  stopLoss: '95',
  takeProfit: '110',
  size: '0.5',
  quoteCurrency: 'usdt',
};
const shortInput = { ...longInput, direction: 'short', stopLoss: '105', takeProfit: '90' };

function expectInvalid(fn: () => unknown, fragment: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(fragment);
    return;
  }
  throw new Error('Expected a ValidationError but nothing was thrown');
}

const planned = (over: Record<string, unknown> = {}) => buildNewTrade({ ...longInput, ...over });
const opened = (t: TradeFields = planned()) =>
  openTrade(t, { entryPrice: '100', openedAt: '2026-10-01T10:00:00Z' });

describe('buildNewTrade: normalisation and defaults', () => {
  it('normalises symbol, currency and decimals; defaults to planned', () => {
    const t = planned({ plannedEntry: '100.00', size: '0.50' });
    expect(t).toMatchObject({
      symbol: 'BTCUSDT',
      quoteCurrency: 'USDT',
      feesCurrency: 'USDT',
      fees: '0',
      status: 'planned',
      plannedEntry: '100',
      size: '0.5',
      setupId: null,
      entryPrice: null,
      exitPrice: null,
      openedAt: null,
      closedAt: null,
      screenshotPath: null,
      planNotes: '',
      reviewNotes: '',
      emotion: '',
    });
  });

  it('keeps tiny crypto amounts exact', () => {
    const t = planned({
      size: '0.00000001',
      plannedEntry: '0.0000002',
      stopLoss: '0.0000001',
      takeProfit: '0.0000003',
    });
    expect(t.size).toBe('0.00000001');
    expect(t.plannedEntry).toBe('0.0000002');
  });

  it('rejects unknown fields instead of ignoring them', () => {
    expectInvalid(() => planned({ pnl: '5' }), /pnl/);
    expectInvalid(() => planned({ exitPrice: '5' }), /exitPrice/);
  });

  it('rejects bad asset class, direction and status', () => {
    expectInvalid(() => planned({ assetClass: 'nft' }), /Asset class/);
    expectInvalid(() => planned({ direction: 'sideways' }), /Direction/);
    expectInvalid(() => planned({ status: 'closed' }), /planned or open/);
  });

  it('rejects bad symbols, currencies and non-numbers', () => {
    expectInvalid(() => planned({ symbol: '' }), /Symbol/);
    expectInvalid(() => planned({ symbol: 'BTC USDT' }), /Symbol/);
    expectInvalid(() => planned({ quoteCurrency: 'U' }), /Quote currency/);
    expectInvalid(() => planned({ plannedEntry: '1e5' }), /Planned entry/);
    expectInvalid(() => planned({ plannedEntry: 'abc' }), /Planned entry/);
    expectInvalid(() => planned({ fees: '-1' }), /Fees/);
  });

  it('validates screenshot references', () => {
    expect(planned({ screenshotPath: 'https://example.com/a.png' }).screenshotPath).toBe(
      'https://example.com/a.png',
    );
    expect(planned({ screenshotPath: 'shots/a.png' }).screenshotPath).toBe('shots/a.png');
    expect(planned({ screenshotPath: 'C:\\shots\\a.png' }).screenshotPath).toBe('C:\\shots\\a.png');
    expect(planned({ screenshotPath: '' }).screenshotPath).toBeNull();
    expectInvalid(() => planned({ screenshotPath: 'javascript:alert(1)' }), /Screenshot/);
    expectInvalid(() => planned({ screenshotPath: 'data:text/html,hi' }), /Screenshot/);
  });
});

describe('stop-loss is mandatory (rule 4)', () => {
  it.each([undefined, '', '   ', null])('rejects stop-loss = %j', (stopLoss) => {
    expectInvalid(() => planned({ stopLoss }), /Stop-loss/);
  });

  it('rejects a zero stop-loss', () => {
    expectInvalid(() => planned({ stopLoss: '0' }), /Stop-loss must be greater than 0/);
  });
});

describe('stop-loss and take-profit sides', () => {
  it('long: stop below entry is OK, equal or above is rejected', () => {
    expect(() => planned({ stopLoss: '99.99' })).not.toThrow();
    expectInvalid(() => planned({ stopLoss: '100' }), /long trade the stop-loss .* must be below/);
    expectInvalid(() => planned({ stopLoss: '101' }), /must be below/);
  });

  it('short: stop above entry is OK, equal or below is rejected', () => {
    expect(() => buildNewTrade({ ...shortInput, stopLoss: '100.01' })).not.toThrow();
    expectInvalid(
      () => buildNewTrade({ ...shortInput, stopLoss: '100' }),
      /short trade the stop-loss .* must be above/,
    );
    expectInvalid(() => buildNewTrade({ ...shortInput, stopLoss: '99' }), /must be above/);
  });

  it('long: take-profit must be above entry', () => {
    expect(() => planned({ takeProfit: '100.01' })).not.toThrow();
    expectInvalid(() => planned({ takeProfit: '100' }), /take-profit .* must be above/);
    expectInvalid(() => planned({ takeProfit: '90' }), /must be above/);
  });

  it('short: take-profit must be below entry', () => {
    expect(() => buildNewTrade({ ...shortInput, takeProfit: '99.99' })).not.toThrow();
    expectInvalid(
      () => buildNewTrade({ ...shortInput, takeProfit: '100' }),
      /take-profit .* must be below/,
    );
    expectInvalid(() => buildNewTrade({ ...shortInput, takeProfit: '110' }), /must be below/);
  });

  it('take-profit is optional', () => {
    expect(planned({ takeProfit: undefined }).takeProfit).toBeNull();
    expect(planned({ takeProfit: null }).takeProfit).toBeNull();
  });

  it('compares numerically, not as text (9 vs 10)', () => {
    // As text "9" > "10", but numerically 9 < 10, so a long with stop 9 and entry 10 is valid.
    expect(() => planned({ plannedEntry: '10', stopLoss: '9', takeProfit: '11' })).not.toThrow();
    expectInvalid(
      () => planned({ plannedEntry: '9', stopLoss: '10', takeProfit: '11' }),
      /must be below/,
    );
  });

  it('works with very small prices', () => {
    expect(() =>
      planned({ plannedEntry: '0.00000200', stopLoss: '0.00000199', takeProfit: '0.00000250' }),
    ).not.toThrow();
    expectInvalid(
      () =>
        planned({ plannedEntry: '0.00000200', stopLoss: '0.00000201', takeProfit: '0.00000250' }),
      /must be below/,
    );
  });

  it('reports every problem at once', () => {
    try {
      planned({ stopLoss: '120', takeProfit: '80' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).issues.map((i) => i.field).sort()).toEqual([
        'stopLoss',
        'takeProfit',
      ]);
    }
  });
});

describe('size and prices must be greater than 0', () => {
  it.each(['0', '0.0', '-1'])('rejects size %s', (size) => {
    expectInvalid(() => planned({ size }), /Size/);
  });
  it.each(['0', '-5'])('rejects planned entry %s', (plannedEntry) => {
    expectInvalid(() => planned({ plannedEntry }), /Planned entry/);
  });
  it('rejects take-profit 0', () => {
    expectInvalid(() => planned({ takeProfit: '0' }), /Take-profit/);
  });
});

describe('creating an open trade', () => {
  const openInput = {
    ...longInput,
    status: 'open',
    entryPrice: '101',
    openedAt: '2026-10-01T10:00:00Z',
  };

  it('needs entry price and opened time', () => {
    expect(buildNewTrade(openInput)).toMatchObject({
      status: 'open',
      entryPrice: '101',
      openedAt: '2026-10-01T10:00:00.000Z',
    });
    expectInvalid(
      () => buildNewTrade({ ...openInput, entryPrice: undefined }),
      /Entry price is required/,
    );
    expectInvalid(
      () => buildNewTrade({ ...openInput, openedAt: undefined }),
      /Opened time is required/,
    );
  });

  it('checks stop and target against the REAL entry price', () => {
    expectInvalid(
      () => buildNewTrade({ ...openInput, entryPrice: '94' }),
      /stop-loss .* below the entry price/,
    );
    expectInvalid(
      () => buildNewTrade({ ...openInput, entryPrice: '111' }),
      /take-profit .* above the entry price/,
    );
  });

  it('a planned trade cannot already have an entry price', () => {
    expectInvalid(
      () => planned({ entryPrice: '100' }),
      /Entry price must be empty on a planned trade/,
    );
  });

  it('rejects invalid timestamps', () => {
    expectInvalid(() => buildNewTrade({ ...openInput, openedAt: 'yesterday' }), /Opened time/);
    expectInvalid(
      () => buildNewTrade({ ...openInput, openedAt: '2026-02-31T10:00:00Z' }),
      /Opened time/,
    );
    expectInvalid(
      () => buildNewTrade({ ...openInput, openedAt: '2026-10-01 10:00' }),
      /Opened time/,
    );
  });
});

describe('lifecycle transitions', () => {
  const allowed: [TradeStatus, TradeStatus][] = [
    ['planned', 'open'],
    ['planned', 'cancelled'],
    ['open', 'closed'],
  ];

  it('allows exactly planned->open, planned->cancelled, open->closed', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('gives a clear message for forbidden moves', () => {
    expectInvalid(
      () => assertTransition('closed', 'open'),
      /closed trade cannot become open.*final/,
    );
    expectInvalid(
      () => assertTransition('open', 'cancelled'),
      /open trade cannot become cancelled.*closed/,
    );
    expectInvalid(
      () => assertTransition('planned', 'closed'),
      /planned trade cannot become closed.*open or cancelled/,
    );
  });

  it('openTrade only works on planned trades', () => {
    const o = opened();
    expect(o.status).toBe('open');
    expectInvalid(
      () => openTrade(o, { entryPrice: '100', openedAt: '2026-10-01T10:00:00Z' }),
      /open trade cannot become open/,
    );
  });

  it('openTrade checks the real entry against the stop', () => {
    expectInvalid(
      () => openTrade(planned(), { entryPrice: '94', openedAt: '2026-10-01T10:00:00Z' }),
      /stop-loss .* below the entry price/,
    );
  });

  it('openTrade needs a valid entry price and time', () => {
    expectInvalid(() => openTrade(planned(), { openedAt: '2026-10-01T10:00:00Z' }), /Entry price/);
    expectInvalid(() => openTrade(planned(), { entryPrice: '100' }), /Opened time/);
  });

  it('cancelTrade only works on planned trades', () => {
    expect(cancelTrade(planned()).status).toBe('cancelled');
    expectInvalid(() => cancelTrade(opened()), /open trade cannot become cancelled/);
    expectInvalid(
      () => cancelTrade(cancelTrade(planned())),
      /cancelled trade cannot become cancelled/,
    );
  });
});

describe('closing a trade', () => {
  const closeInput = { exitPrice: '108', closedAt: '2026-10-02T10:00:00Z' };

  it('closes an open trade with exit price and time', () => {
    const c = closeTrade(opened(), closeInput);
    expect(c).toMatchObject({
      status: 'closed',
      exitPrice: '108',
      closedAt: '2026-10-02T10:00:00.000Z',
    });
  });

  it('requires an exit price and a closed time', () => {
    expectInvalid(() => closeTrade(opened(), { closedAt: closeInput.closedAt }), /Exit price/);
    expectInvalid(() => closeTrade(opened(), { exitPrice: '108' }), /Closed time/);
    expectInvalid(
      () => closeTrade(opened(), { ...closeInput, exitPrice: '0' }),
      /Exit price must be greater than 0/,
    );
  });

  it('closed time cannot be earlier than opened time (equal is fine)', () => {
    expectInvalid(
      () => closeTrade(opened(), { ...closeInput, closedAt: '2026-10-01T09:59:59Z' }),
      /cannot be earlier than opened time/,
    );
    expect(() =>
      closeTrade(opened(), { ...closeInput, closedAt: '2026-10-01T10:00:00Z' }),
    ).not.toThrow();
  });

  it('cannot close a planned, closed or cancelled trade', () => {
    expectInvalid(() => closeTrade(planned(), closeInput), /planned trade cannot become closed/);
    expectInvalid(
      () => closeTrade(closeTrade(opened(), closeInput), closeInput),
      /closed trade cannot become closed/,
    );
    expectInvalid(
      () => closeTrade(cancelTrade(planned()), closeInput),
      /cancelled trade cannot become closed/,
    );
  });

  it('can set fees and review notes while closing, and works for shorts', () => {
    const shortOpen = openTrade(buildNewTrade(shortInput), {
      entryPrice: '100',
      openedAt: '2026-10-01T10:00:00Z',
    });
    const c = closeTrade(shortOpen, {
      ...closeInput,
      exitPrice: '92',
      fees: '0.25',
      feesCurrency: 'usdt',
      reviewNotes: 'ok',
      emotion: 'calm',
    });
    expect(c).toMatchObject({
      direction: 'short',
      fees: '0.25',
      feesCurrency: 'USDT',
      reviewNotes: 'ok',
      emotion: 'calm',
    });
  });

  it('keeps existing fees when none are given', () => {
    const c = closeTrade(opened(planned({ fees: '1.5' })), closeInput);
    expect(c.fees).toBe('1.5');
  });
});

describe('editing and locks', () => {
  const closed = () => closeTrade(opened(), { exitPrice: '108', closedAt: '2026-10-02T10:00:00Z' });

  it('planned: everything planning-related is editable and rules are re-checked', () => {
    const t = editTrade(planned(), {
      symbol: 'eth',
      plannedEntry: '200',
      stopLoss: '190',
      takeProfit: '220',
      size: '2',
    });
    expect(t).toMatchObject({
      symbol: 'ETH',
      plannedEntry: '200',
      stopLoss: '190',
      takeProfit: '220',
      size: '2',
    });
    expectInvalid(() => editTrade(planned(), { stopLoss: '100' }), /must be below/);
    expectInvalid(() => editTrade(planned(), { direction: 'short' }), /short trade the stop-loss/);
  });

  it('planned: take-profit and setup can be cleared with null', () => {
    expect(editTrade(planned(), { takeProfit: null }).takeProfit).toBeNull();
    expect(editTrade(planned({ setupId: 3 }), { setupId: null }).setupId).toBeNull();
  });

  it('open: only stop, target, fees, setup and notes can change', () => {
    const o = opened();
    expect(editTrade(o, { stopLoss: '97', takeProfit: '115', planNotes: 'trail' })).toMatchObject({
      stopLoss: '97',
      takeProfit: '115',
      planNotes: 'trail',
    });
    expectInvalid(() => editTrade(o, { size: '9' }), /size: cannot be changed on a open trade/);
    expectInvalid(() => editTrade(o, { symbol: 'ETH' }), /symbol: cannot be changed/);
    expectInvalid(() => editTrade(o, { direction: 'short' }), /direction: cannot be changed/);
    expectInvalid(() => editTrade(o, { plannedEntry: '1' }), /plannedEntry: cannot be changed/);
  });

  it('open: stop-loss rules still apply when moving the stop', () => {
    expectInvalid(() => editTrade(opened(), { stopLoss: '100' }), /must be below the entry price/);
    expectInvalid(() => editTrade(opened(), { stopLoss: '101' }), /must be below/);
  });

  it('closed: only review notes, emotion and screenshot can change', () => {
    const c = closed();
    expect(
      editTrade(c, { reviewNotes: 'good', emotion: 'calm', screenshotPath: 'a.png' }),
    ).toMatchObject({
      reviewNotes: 'good',
      emotion: 'calm',
      screenshotPath: 'a.png',
      exitPrice: '108',
    });
    for (const field of ['exitPrice', 'entryPrice']) {
      // Not editable fields at all: rejected as unknown input.
      expectInvalid(() => editTrade(c, { [field]: '5' }), /cannot be set here/);
    }
    for (const field of ['stopLoss', 'size', 'fees', 'planNotes', 'setupId']) {
      expectInvalid(
        () => editTrade(c, { [field]: field === 'setupId' ? 1 : '5' }),
        /cannot be changed on a closed trade/,
      );
    }
  });

  it('cancelled: fully locked', () => {
    expectInvalid(
      () => editTrade(cancelTrade(planned()), { reviewNotes: 'x' }),
      /cancelled trade is locked/,
    );
  });

  it('cannot move a trade to another account or change status/dates via edit', () => {
    expectInvalid(() => editTrade(planned(), { accountId: 2 }), /accountId/);
    expectInvalid(() => editTrade(planned(), { status: 'closed' }), /status/);
    expectInvalid(() => editTrade(opened(), { openedAt: '2026-10-01T10:00:00Z' }), /openedAt/);
  });

  it('exposes the editable field list per status', () => {
    expect(editableFields('closed')).toEqual(['reviewNotes', 'emotion', 'screenshotPath']);
    expect(editableFields('cancelled')).toEqual([]);
    expect(editableFields('open')).toContain('stopLoss');
    expect(editableFields('open')).not.toContain('size');
  });

  it('an empty edit changes nothing', () => {
    const t = planned();
    expect(editTrade(t, {})).toEqual(t);
  });
});

describe('findTradeIssues: invariants guard the stored data too', () => {
  it('flags an open trade without entry price, and a closed one without exit', () => {
    const o = { ...opened(), entryPrice: null };
    expect(findTradeIssues(o).map((i) => i.field)).toContain('entryPrice');
    const c = { ...opened(), status: 'closed' as const };
    expect(findTradeIssues(c).map((i) => i.field)).toEqual(
      expect.arrayContaining(['exitPrice', 'closedAt']),
    );
  });

  it('flags a missing stop-loss on stored data', () => {
    expect(findTradeIssues({ ...planned(), stopLoss: '' }).map((i) => i.field)).toContain(
      'stopLoss',
    );
  });
});

describe('initial stop-loss (frozen when the trade opens)', () => {
  const openAt = { entryPrice: '100', openedAt: '2026-10-01T10:00:00Z' };

  it('is empty while planned and cancelled', () => {
    expect(planned().initialStopLoss).toBeNull();
    expect(cancelTrade(planned()).initialStopLoss).toBeNull();
  });

  it('is set when a trade is created already open', () => {
    const t = buildNewTrade({
      ...longInput,
      status: 'open',
      entryPrice: '101',
      openedAt: '2026-10-01T10:00:00Z',
    });
    expect(t.initialStopLoss).toBe('95');
  });

  it('is set when a planned trade opens, using the stop at that moment', () => {
    const edited = editTrade(planned(), { stopLoss: '97' }); // plan changed before opening
    const o = openTrade(edited, openAt);
    expect(o).toMatchObject({ stopLoss: '97', initialStopLoss: '97' });
  });

  it('does not change when the live stop is moved or the trade closes', () => {
    const o = opened(); // initial 95
    const moved = editTrade(o, { stopLoss: '99' });
    expect(moved).toMatchObject({ stopLoss: '99', initialStopLoss: '95' });
    const closed = closeTrade(moved, { exitPrice: '108', closedAt: '2026-10-02T10:00:00Z' });
    expect(closed).toMatchObject({ stopLoss: '99', initialStopLoss: '95' });
  });

  it('cannot be edited directly', () => {
    expectInvalid(() => editTrade(opened(), { initialStopLoss: '90' }), /initialStopLoss/);
    expectInvalid(() => editTrade(planned(), { initialStopLoss: '90' }), /initialStopLoss/);
    expectInvalid(() => planned({ initialStopLoss: '90' }), /initialStopLoss/);
  });

  it('is part of the invariants: required when open/closed, forbidden when planned/cancelled', () => {
    const fields = (t: TradeFields) => findTradeIssues(t).map((i) => i.field);
    expect(fields({ ...opened(), initialStopLoss: null })).toContain('initialStopLoss');
    expect(fields({ ...planned(), initialStopLoss: '95' })).toContain('initialStopLoss');
    expect(fields({ ...cancelTrade(planned()), initialStopLoss: '95' })).toContain(
      'initialStopLoss',
    );
  });

  it('must be on the correct side of the real entry', () => {
    expect(
      findTradeIssues({ ...opened(), initialStopLoss: '100' })
        .map((i) => i.message)
        .join(),
    ).toMatch(/initial stop-loss .* below the entry price/);
    expect(
      findTradeIssues({ ...opened(), initialStopLoss: '101' })
        .map((i) => i.message)
        .join(),
    ).toMatch(/must be below/);
    const short = openTrade(buildNewTrade(shortInput), openAt);
    expect(short.initialStopLoss).toBe('105');
    expect(
      findTradeIssues({ ...short, initialStopLoss: '99' })
        .map((i) => i.message)
        .join(),
    ).toMatch(/must be above/);
  });
});

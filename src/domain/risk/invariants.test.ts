import { describe, expect, it } from 'vitest';
import { Dec } from '../money/decimal';
import { evaluatePlan } from './evaluate';
import { buildContext, ctx, openTrade, plan } from './fixtures';
import { HARD_CEILINGS, RISK_DEFAULTS, parseRiskSettings, type RiskSettings } from './settings';
import { calculatePositionSize } from './size';
import type { ActiveHalt } from './context';

/**
 * Invariants over many seeded pseudo-random inputs (a failure is always reproducible).
 * Numbers are built from whole numbers as text: no floating point is used for money.
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
function decimalText(n: number, places: number): string {
  const digits = String(n).padStart(places + 1, '0');
  const cut = digits.length - places;
  return places === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const D = (v: string) => new Dec(v);

function sizeCase(seed: number) {
  const rnd = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(items: T[]) => items[int(0, items.length - 1)]!;

  const equity = decimalText(int(1000, 100_000_000), pick([0, 2, 4]));
  const riskPercent = pick(['0.1', '0.25', '0.5', '1', '1.5', '2', '0.3333', '1.2345']);
  const direction = pick(['long', 'short']);
  const entryUnits = int(100, 5_000_000);
  const dist = int(1, Math.max(1, Math.min(entryUnits - 1, 400_000)));
  const entry = decimalText(entryUnits, 2);
  const stop = decimalText(direction === 'long' ? entryUnits - dist : entryUnits + dist, 2);
  const sizeStep = pick([undefined, '1', '0.1', '0.01', '0.001', '0.00001', '0.00000001']);
  const fee = pick([undefined, '0', '0.1', '0.2', '0.75']);
  const result = calculatePositionSize({
    equity,
    riskPercent,
    direction,
    entry,
    stop,
    sizeStep,
    feeRoundTripPercent: fee,
  });
  return { equity, riskPercent, direction, entry, stop, sizeStep, fee, result };
}

describe.each(SEEDS)('size calculator invariants, case %i', (seed) => {
  const { equity, riskPercent, direction, entry, stop, sizeStep, fee, result } = sizeCase(seed);

  it('never exceeds the risk budget, never rounds up, and is a multiple of the step', () => {
    if (!result.ok) {
      // the only legitimate refusal for these inputs: not even one step fits in the budget
      expect(result.problems.map((p) => p.code)).toEqual(['SIZE_BELOW_MINIMUM']);
      return;
    }
    const distance = D(entry).minus(stop).abs();
    const feePerUnit = D(entry)
      .times(fee ?? '0')
      .div(100);
    const perUnit = distance.plus(feePerUnit);
    const budget = D(equity).times(riskPercent).div(100);
    const size = D(result.size);

    // 1. money at risk (price risk + estimated fees) never exceeds the budget, exactly
    expect(size.times(perUnit).lte(budget)).toBe(true);
    expect(D(result.riskAmount).lte(budget)).toBe(true);
    // 2. size is a whole number of steps
    if (sizeStep) expect(size.mod(sizeStep).isZero()).toBe(true);
    // 3. it is the LARGEST such size: one more step (or 1e-18) would exceed the budget (not rounded down by too much)
    const unit = sizeStep ?? '0.000000000000000001';
    expect(size.plus(unit).times(perUnit).gt(budget)).toBe(true);
    // 4. the shown percent never understates the real one
    const real = D(result.riskAmount).plus(result.estimatedFees).times(100).div(equity);
    expect(D(result.riskPercentUsed).gte(real)).toBe(true);
    expect(D(result.riskPercentUsed).lte(real.plus('0.0001'))).toBe(true);
    // 5. notional is exact
    expect(D(result.notional).eq(size.times(entry))).toBe(true);
  });

  it('a size it returns is always approved by the plan evaluation (calculator and rules agree)', () => {
    if (!result.ok) return;
    const verdict = evaluatePlan(
      plan({ direction, entry, stop, target: null, size: result.size }),
      ctx({
        equity,
        dayStartEquity: equity,
        settings: { ...RISK_DEFAULTS, maxRiskPerTradePercent: '2' },
      }),
    );
    // The calculator used `riskPercent` (<= 2); the evaluation limit is set to the ceiling here, so
    // the only thing that can fail is the risk-per-trade check itself.
    expect(verdict.violations.filter((v) => v.code === 'MAX_RISK_PER_TRADE')).toEqual([]);
  });
});

function randomSettings(rnd: () => number): {
  settings: RiskSettings;
  raw: Record<string, unknown>;
} {
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pct = (ceiling: number) => decimalText(int(1, ceiling * 100), 2);
  const raw = {
    maxRiskPerTradePercent: pct(2),
    maxDailyLossPercent: pct(5),
    maxOpenRiskPercent: pct(6),
    maxOpenTrades: int(1, 6),
    maxDrawdownPercent: pct(20),
    minRewardToRisk: decimalText(int(10, 500), 2),
  };
  const parsed = parseRiskSettings(raw);
  if (!parsed.ok) throw new Error(parsed.problem);
  return { settings: parsed.settings, raw };
}

function evalCase(seed: number) {
  const rnd = mulberry32(seed * 7919);
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(items: T[]) => items[int(0, items.length - 1)]!;

  const equity = decimalText(int(1000, 5_000_000), 2);
  const eq = D(equity);
  const { settings } = randomSettings(rnd);
  const direction = pick(['long', 'short']);
  const entryUnits = int(1000, 500_000);
  const distUnits = int(1, Math.min(entryUnits - 1, 40_000));
  const distance = D(decimalText(distUnits, 2));

  // Plan size: around the per-trade limit (from 5 % to 130 % of it), so approvals AND refusals are common.
  const limit = eq.times(settings.maxRiskPerTradePercent).div(100);
  const wanted = limit
    .times(decimalText(int(5, 130), 2))
    .div(distance)
    .toDecimalPlaces(2, Dec.ROUND_DOWN);
  const size = wanted.lt('0.01') ? '0.01' : wanted.toFixed();

  // Open trades: each risks between 0.01 % and 1.5 % of equity.
  const open = Array.from({ length: int(0, 4) }, (_, i) => {
    const oEntryUnits = int(1000, 100_000);
    const oDistUnits = int(1, Math.min(oEntryUnits - 1, 5000));
    const oRisk = eq
      .times(decimalText(int(1, 150), 4))
      .div(100)
      .times(100); // fraction of equity
    const oSize = oRisk.div(decimalText(oDistUnits, 2)).toDecimalPlaces(2, Dec.ROUND_DOWN);
    return openTrade({
      tradeId: i + 1,
      quoteCurrency: rnd() < 0.04 ? 'EUR' : 'USDT',
      entryPrice: decimalText(oEntryUnits, 2),
      initialStopLoss: rnd() < 0.04 ? null : decimalText(oEntryUnits - oDistUnits, 2),
      size: oSize.lt('0.01') ? '0.01' : oSize.toFixed(),
    });
  });
  const halts: ActiveHalt[] =
    rnd() < 0.1
      ? [
          {
            kind: pick(['daily_loss', 'drawdown', 'manual'] as const),
            message: 'halt',
            since: null,
            clearsAt: null,
            resetAllowedNow: false,
            resetAvailableAt: null,
            resetRemainingMs: null,
          },
        ]
      : [];
  const p = plan({
    direction,
    entry: decimalText(entryUnits, 2),
    stop:
      rnd() < 0.04
        ? null
        : decimalText(direction === 'long' ? entryUnits - distUnits : entryUnits + distUnits, 2),
    target:
      rnd() < 0.5
        ? null
        : decimalText(
            direction === 'long'
              ? entryUnits + distUnits * 2
              : Math.max(1, entryUnits - distUnits * 2),
            2,
          ),
    size,
    quoteCurrency: rnd() < 0.04 ? 'EUR' : 'USDT',
  });
  const context = ctx({ equity, dayStartEquity: equity, settings, openTrades: open, halts });
  return {
    equity,
    settings,
    direction,
    open,
    halts,
    p,
    context,
    verdict: evaluatePlan(p, context),
  };
}

describe.each(SEEDS)('plan evaluation invariants, case %i', (seed) => {
  const { equity, settings, direction, open, halts, p, context, verdict } = evalCase(seed);

  it('an approved plan never breaks a hard ceiling or any of its own limits', () => {
    if (!verdict.approved) {
      expect(verdict.violations.length).toBeGreaterThan(0);
      return;
    }
    const risk = D(p.entry as string)
      .minus(p.stop as string)
      .abs()
      .times(p.size as string);
    const eq = D(equity);
    // the engine's own limits (exact)
    expect(risk.times(100).lte(eq.times(settings.maxRiskPerTradePercent))).toBe(true);
    // the hard ceilings, which settings can never exceed
    expect(risk.times(100).lte(eq.times(HARD_CEILINGS.maxRiskPerTradePercent))).toBe(true);
    expect(open.length + 1).toBeLessThanOrEqual(settings.maxOpenTrades);
    expect(open.length + 1).toBeLessThanOrEqual(HARD_CEILINGS.maxOpenTrades);
    const openRisk = open.reduce(
      (sum, t) =>
        sum.plus(
          D(t.entryPrice as string)
            .minus(t.initialStopLoss as string)
            .abs()
            .times(t.size as string),
        ),
      new Dec(0),
    );
    expect(openRisk.plus(risk).times(100).lte(eq.times(settings.maxOpenRiskPercent))).toBe(true);
    expect(openRisk.plus(risk).times(100).lte(eq.times(HARD_CEILINGS.maxOpenRiskPercent))).toBe(
      true,
    );
    // never approved while halted, with a bad stop, or in another currency
    expect(halts).toEqual([]);
    expect(p.quoteCurrency).toBe('USDT');
    expect(p.stop).not.toBeNull();
    expect(
      direction === 'long'
        ? D(p.stop as string).lt(p.entry as string)
        : D(p.stop as string).gt(p.entry as string),
    ).toBe(true);
    expect(open.every((t) => t.quoteCurrency === 'USDT' && t.initialStopLoss !== null)).toBe(true);
  });

  it('the verdict is deterministic', () => {
    expect(
      evaluatePlan(p, ctx({ equity, dayStartEquity: equity, settings, openTrades: open, halts })),
    ).toEqual(verdict);
    expect(evaluatePlan(p, context)).toEqual(verdict);
  });
});

describe('settings above a hard ceiling are never usable', () => {
  const OVER: [string, unknown][] = [
    ['maxRiskPerTradePercent', '2.01'],
    ['maxDailyLossPercent', '5.01'],
    ['maxOpenRiskPercent', '6.01'],
    ['maxOpenTrades', 7],
    ['maxDrawdownPercent', '20.01'],
  ];
  it.each(OVER)(
    '%s = %j: parse fails, and a plan is refused with SETTINGS_INVALID',
    (field, value) => {
      expect(parseRiskSettings({ ...RISK_DEFAULTS, [field]: value }).ok).toBe(false);
      const c = buildContext({
        settingsJson: JSON.stringify({ ...RISK_DEFAULTS, [field]: value }),
      });
      const v = evaluatePlan(plan(), c);
      expect(v.approved).toBe(false);
      expect(v.violations.map((x) => x.code)).toContain('SETTINGS_INVALID');
    },
  );
});

describe('generator sanity (so the invariants above are not vacuous)', () => {
  it('the size cases include many successful sizes and some refusals', () => {
    const results = SEEDS.map((seed) => sizeCase(seed).result);
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(150);
    expect(results.filter((r) => !r.ok).length).toBeGreaterThan(0);
  });

  it('the evaluation cases include approvals and refusals of several kinds', () => {
    const verdicts = SEEDS.map((seed) => evalCase(seed).verdict);
    expect(verdicts.filter((v) => v.approved).length).toBeGreaterThan(20);
    expect(verdicts.filter((v) => !v.approved).length).toBeGreaterThan(20);
    const codes = new Set(verdicts.flatMap((v) => v.violations.map((x) => x.code)));
    for (const expected of [
      'MAX_RISK_PER_TRADE',
      'MAX_OPEN_TRADES',
      'MAX_OPEN_RISK',
      'CURRENCY_MISMATCH',
      'NO_STOP_LOSS',
      'OPEN_RISK_UNVERIFIABLE',
    ]) {
      expect(codes.has(expected as never), expected).toBe(true);
    }
    expect(verdicts.some((v) => v.violations.some((x) => x.code.startsWith('HALTED')))).toBe(true);
  });
});

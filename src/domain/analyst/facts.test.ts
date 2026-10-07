import { describe, expect, it } from 'vitest';
import type { RiskSettings, VerdictNumbers } from '../risk';
import type { GroupStats, TradeResult } from '../stats';
import {
  factsFromGroupStats,
  factsFromRiskSettings,
  factsFromTradeResult,
  factsFromVerdictNumbers,
} from './facts';
import { buildTutorPrompt } from './prompt';

const m = (value: string | null, reason: string | null = null) => ({ value, reason });

// Every field has a DIFFERENT value, so a swapped or mislabelled mapping is caught.
const stats: GroupStats = {
  tradeCount: 11,
  wins: 6,
  losses: 4,
  breakevens: 1,
  winRatePercent: m('54.55'),
  grossPnl: '101',
  totalFees: '2',
  netPnl: '99',
  totalWinners: '150',
  totalLosers: '-51',
  averageWin: m('25'),
  averageLoss: m('-12.75'),
  largestWin: m('60'),
  largestLoss: m('-30'),
  averageR: m('0.3'),
  expectancyR: m('0.25'),
  expectancyMoney: m('9'),
  profitFactor: m('2.94'),
  payoffRatio: m('1.96'),
  longestWinStreak: 3,
  longestLossStreak: 2,
  maxDrawdown: { amount: '70', percent: m('7.5') },
  sampleSize: { tradeCount: 11, minimumReliable: 30, reliable: false, warning: 'small' },
  flags: { tradesWithExcludedFees: 5, rTradeCount: 8, netRTradeCount: 7 },
};

const byKey = (facts: { key: string; value: unknown }[]) =>
  Object.fromEntries(facts.map((f) => [f.key, f.value]));

describe('factsFromGroupStats', () => {
  const facts = factsFromGroupStats(stats);
  const k = byKey(facts);

  it('labels every engine number with the right value (no swaps)', () => {
    expect(k).toMatchObject({
      'closed trades': 11,
      wins: 6,
      losses: 4,
      breakevens: 1,
      'win rate percent': '54.55',
      'gross P&L (before fees)': '101',
      'total fees': '2',
      'net P&L (after fees)': '99',
      'total winners (net)': '150',
      'total losers (net)': '-51',
      'average win': '25',
      'average loss': '-12.75',
      'largest win': '60',
      'largest loss': '-30',
      'expectancy (R)': '0.25',
      'expectancy (money)': '9',
      'profit factor': '2.94',
      'payoff ratio': '1.96',
      'longest win streak': 3,
      'longest loss streak': 2,
      'max drawdown amount': '70',
      'max drawdown percent': '7.5',
      'trades whose fees were left out (other currency)': 5,
    });
  });

  it('marks every number as citable, and nothing else', () => {
    expect(facts.every((f) => f.figure === true)).toBe(true);
  });

  it('a number that cannot be computed stays n/a with its reason, never zero', () => {
    const f = factsFromGroupStats({ ...stats, profitFactor: m(null, 'no losing trades') });
    expect(f.find((x) => x.key === 'profit factor')).toEqual({
      key: 'profit factor',
      value: null,
      figure: true,
    });
    expect(f.find((x) => x.key === 'profit factor (why n/a)')).toEqual({
      key: 'profit factor (why n/a)',
      value: 'no losing trades',
    });
    // a reason is never citable, and a null never becomes an allowed figure
    const prompt = buildTutorPrompt({ question: 'q', currency: 'USDT', metrics: f });
    expect(prompt.allowedFigures).not.toContain('null');
    expect(prompt.allowedFigures).not.toContain('no losing trades');
  });

  it('a real zero stays zero and is citable', () => {
    const f = factsFromGroupStats({ ...stats, totalFees: '0', wins: 0 });
    expect(f.find((x) => x.key === 'total fees')?.value).toBe('0');
    expect(
      buildTutorPrompt({ question: 'q', currency: null, metrics: f }).allowedFigures,
    ).toContain('0');
  });

  it('maps every numeric field of the stats (a new stat that is not mapped fails here)', () => {
    const values = new Set(facts.map((f) => String(f.value)));
    const scalar = (v: unknown): string[] =>
      typeof v === 'string' || typeof v === 'number'
        ? [String(v)]
        : v && typeof v === 'object' && 'value' in v
          ? [String((v as { value: unknown }).value)]
          : [];
    const skip = new Set(['sampleSize', 'flags', 'maxDrawdown', 'averageR']); // averageR: gross R is not sent
    for (const [key, v] of Object.entries(stats)) {
      if (skip.has(key)) continue;
      for (const s of scalar(v))
        expect(values.has(s), `${key} = ${s} is not in the facts`).toBe(true);
    }
  });
});

describe('factsFromTradeResult', () => {
  const r = {
    tradeId: 1,
    closedAt: 'x',
    grossPnl: '12',
    feesApplied: '1',
    feesExcluded: false,
    netPnl: '11',
    outcome: 'win',
    initialRisk: m('10'),
    grossR: m('1.2'),
    netR: m('1.1'),
  } as TradeResult;
  it('copies net P&L and net R', () => {
    expect(factsFromTradeResult(r)).toEqual([
      { key: 'net P&L', value: '11', figure: true },
      { key: 'net R', value: '1.1', figure: true },
    ]);
  });
  it('net R unavailable is n/a with its reason', () => {
    const f = factsFromTradeResult({ ...r, netR: m(null, 'no stop') });
    expect(f).toEqual([
      { key: 'net P&L', value: '11', figure: true },
      { key: 'net R', value: null, figure: true },
      { key: 'net R (why n/a)', value: 'no stop' },
    ]);
  });
});

describe('factsFromVerdictNumbers / factsFromRiskSettings', () => {
  it('map all fields with their own values', () => {
    const n: VerdictNumbers = {
      equity: '10000',
      riskAmount: '50',
      riskPercent: '0.5',
      riskLimitAmount: '100',
      openRiskBefore: '20',
      openRiskAfter: '70',
      openRiskAfterPercent: '0.7',
      openRiskLimitAmount: '300',
      openTradesBefore: 1,
      openTradesAfter: 2,
      maxOpenTrades: 3,
      rewardToRisk: '2',
    };
    const facts = factsFromVerdictNumbers(n);
    expect(facts).toHaveLength(12);
    expect(byKey(facts)).toMatchObject({
      'equity (account currency)': '10000',
      'risk percent of equity': '0.5',
      'open risk after percent': '0.7',
      'open trades before': 1,
      'open trades after': 2,
      'max open trades': 3,
      'reward-to-risk': '2',
    });
    expect(facts.every((f) => f.figure === true)).toBe(true);
  });
  it('risk settings are listed with their own values', () => {
    const s: RiskSettings = {
      maxRiskPerTradePercent: '1',
      maxDailyLossPercent: '3',
      maxOpenRiskPercent: '4',
      maxOpenTrades: 5,
      maxDrawdownPercent: '10',
      minRewardToRisk: '1.5',
    };
    expect(byKey(factsFromRiskSettings(s))).toEqual({
      'max risk per trade percent': '1',
      'max daily loss percent': '3',
      'max total open risk percent': '4',
      'max open trades': 5,
      'max drawdown percent': '10',
      'minimum reward-to-risk': '1.5',
    });
  });
});

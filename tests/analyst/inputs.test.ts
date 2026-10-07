import { describe, expect, it } from 'vitest';
import { loadPlanReviewFacts, loadTutorFacts, loadWeeklyFacts } from '@/analyst/inputs';
import { createTrade, closeTrade } from '@/data/trades';
import { buildPlanReviewPrompt, buildTutorPrompt, buildWeeklyReviewPrompt } from '@/domain/analyst';
import { riskDb } from '../helpers/risk';

const NOW = new Date('2026-03-10T12:00:00.000Z');

function trade(
  db: ReturnType<typeof riskDb>,
  o: {
    pnl: number;
    closedAt: string;
    currency?: string;
    notes?: string;
    emotion?: string;
    review?: string;
  },
) {
  const currency = o.currency ?? 'USDT';
  const t = createTrade(
    db,
    {
      accountId: 1,
      symbol: 'BTCUSDT',
      assetClass: 'crypto',
      direction: 'long',
      status: 'open',
      plannedEntry: '100',
      stopLoss: '90',
      size: '1',
      quoteCurrency: currency,
      entryPrice: '100',
      openedAt: '2026-03-01T00:00:00Z',
      planNotes: o.notes ?? '',
      emotion: o.emotion ?? '',
      feesCurrency: currency,
    },
    { now: () => new Date('2026-03-01T00:00:00Z') },
  );
  return closeTrade(
    db,
    t.id,
    { exitPrice: String(100 + o.pnl), closedAt: o.closedAt, reviewNotes: o.review ?? '' },
    { now: () => new Date(o.closedAt) },
  );
}

describe('weekly review facts', () => {
  const req = { accountId: 1, from: '2026-03-02', to: '2026-03-08', currency: 'USDT' };

  it('includes only closed trades in the range (both end dates included, UTC days) in ONE currency', () => {
    const db = riskDb();
    trade(db, { pnl: 1, closedAt: '2026-03-01T23:59:59.000Z' }); // before
    trade(db, { pnl: 2, closedAt: '2026-03-02T00:00:00.000Z', notes: 'first' }); // first instant
    trade(db, { pnl: 3, closedAt: '2026-03-08T23:59:59.000Z' }); // last instant
    trade(db, { pnl: 4, closedAt: '2026-03-09T00:00:00.000Z' }); // after
    trade(db, { pnl: 5, closedAt: '2026-03-05T00:00:00.000Z', currency: 'EUR' }); // other currency
    const r = loadWeeklyFacts(db, req);
    if (!r.ok) throw new Error(r.message);
    expect(r.facts.trades.map((t) => t.figures[0]?.value)).toEqual(['2', '3']);
    expect(r.facts.currency).toBe('USDT');
    const net = r.facts.stats.find((f) => f.key === 'net P&L (after fees)');
    expect(net?.value).toBe('5');
  });

  it('copies the engine numbers, notes, emotion, setup and the override flag; warns about a small sample', () => {
    const db = riskDb();
    const t = trade(db, {
      pnl: 2,
      closedAt: '2026-03-03T10:00:00.000Z',
      notes: 'waited',
      emotion: 'calm',
      review: 'ok',
    });
    db.$client
      .prepare(
        "INSERT INTO risk_verdicts (trade_id, stage, approved, violation_codes, warning_codes, snapshot_json, override_reason, created_at) VALUES (?, 'created', 0, '[\"MAX_RISK_PER_TRADE\"]', '[]', '{}', 'I was sure about it', 't')",
      )
      .run(t.id);
    const r = loadWeeklyFacts(db, req);
    if (!r.ok) throw new Error(r.message);
    expect(r.facts.overrideCount).toBe(1);
    expect(r.facts.trades[0]).toMatchObject({
      overridden: true,
      emotion: 'calm',
      planNotes: 'waited',
      reviewNotes: 'ok',
    });
    expect(r.facts.sampleWarning).toMatch(/trades/i);
    const prompt = buildWeeklyReviewPrompt(r.facts);
    expect(prompt.user).toContain('logged by OVERRIDE of a refusal: yes');
    expect(prompt.allowedFigures).toContain('2');
  });

  it('refuses bad input with plain messages', () => {
    const db = riskDb();
    expect(loadWeeklyFacts(db, { ...req, from: '' })).toMatchObject({ ok: false });
    expect(loadWeeklyFacts(db, { ...req, from: '2026-03-09', to: '2026-03-01' })).toMatchObject({
      ok: false,
    });
    expect(loadWeeklyFacts(db, { ...req, from: '2024-01-01', to: '2026-03-01' })).toMatchObject({
      ok: false,
    });
    expect(loadWeeklyFacts(db, { ...req, currency: '' })).toMatchObject({ ok: false });
    expect(loadWeeklyFacts(db, { ...req, accountId: 99 })).toMatchObject({ ok: false });
    expect(loadWeeklyFacts(db, req)).toMatchObject({
      ok: false,
      message: expect.stringContaining('no closed trades'),
    });
  });
});

describe('plan review facts', () => {
  const plan = {
    symbol: 'BTCUSDT',
    direction: 'long',
    entry: '100',
    stop: '95',
    target: '110',
    size: '2',
    quoteCurrency: 'USDT',
  };
  const base = { accountId: 1, plan, setupId: null, planNotes: 'note', emotion: 'calm' };

  it('recomputes the verdict on the server with the real engine', () => {
    const db = riskDb();
    const ok = loadPlanReviewFacts(db, base, NOW);
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.facts.verdict.approved).toBe(true); // risk 10 on 10000 = 0.1 %
    const big = loadPlanReviewFacts(db, { ...base, plan: { ...plan, size: '1000' } }, NOW);
    if (!big.ok) throw new Error(big.message);
    expect(big.facts.verdict.approved).toBe(false);
    expect(big.facts.verdict.violations.join()).toMatch(/MAX_RISK_PER_TRADE/);
  });

  it('carries the saved rules and the verdict numbers as citable figures', () => {
    const db = riskDb();
    const r = loadPlanReviewFacts(db, base, NOW);
    if (!r.ok) throw new Error(r.message);
    const p = buildPlanReviewPrompt(r.facts);
    expect(p.user).toContain('max risk per trade percent: 1');
    expect(p.user).toContain('verdict: APPROVED');
    expect(p.allowedFigures).toEqual(expect.arrayContaining(['100', '95', '110', '2', '10000']));
  });

  it('refuses an unknown account', () => {
    expect(loadPlanReviewFacts(riskDb(), { ...base, accountId: 9 }, NOW)).toMatchObject({
      ok: false,
    });
  });
});

describe('tutor facts', () => {
  it("uses the user's own metrics when there are closed trades, and none otherwise", () => {
    const db = riskDb();
    expect(loadTutorFacts(db, 'q', 1).metrics).toEqual([]);
    trade(db, { pnl: 2, closedAt: '2026-03-03T10:00:00.000Z' });
    const f = loadTutorFacts(db, 'q', 1);
    expect(f.currency).toBe('USDT');
    expect(buildTutorPrompt(f).user).toContain('net P&L (after fees): 2');
    expect(loadTutorFacts(db, 'q', null)).toEqual({ question: 'q', currency: null, metrics: [] });
  });
});

describe('what is NEVER loaded', () => {
  it('no account name, id or number reaches any prompt', () => {
    const db = riskDb(); // the account is called "Paper"
    trade(db, { pnl: 2, closedAt: '2026-03-03T10:00:00.000Z' });
    const weekly = loadWeeklyFacts(db, {
      accountId: 1,
      from: '2026-03-02',
      to: '2026-03-08',
      currency: 'USDT',
    });
    if (!weekly.ok) throw new Error(weekly.message);
    const text = buildWeeklyReviewPrompt(weekly.facts);
    const all = text.system + text.user;
    expect(all).not.toMatch(/\bPaper\b/);
    expect(all).not.toMatch(/account(?:_| )?id/i);
  });
});

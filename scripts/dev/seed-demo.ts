import { createAccount, listAccounts } from '@/data/accounts';
import type { Db } from '@/data/client';
import { appendRiskEvent } from '@/data/risk-events';
import { riskVerdicts } from '@/data/schema';
import { createSetup } from '@/data/setups';
import { cancelTrade, closeTrade, createTrade, type Trade } from '@/data/trades';
import { SeedRefusedError } from './guard';

/**
 * Fills an EMPTY database with clearly named DEMO data so the dashboard can be looked at: one
 * "DEMO Paper Account", a few setups, closed, open, planned and cancelled trades, one trade in
 * another currency, one with fees in another currency, and one example override. Deterministic
 * (a fixed pseudo-random sequence) and relative to `now`, so "today" has data. It only inserts
 * demo rows; nothing here is ever shown as advice or real.
 */

export const DEMO_ACCOUNT_NAME = 'DEMO Paper Account';

/** mulberry32: a tiny deterministic generator (the same demo every time). */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = [
  { symbol: 'BTCUSDT', price: 64000 },
  { symbol: 'ETHUSDT', price: 3100 },
  { symbol: 'SOLUSDT', price: 145 },
];
// Results in R, chosen so the demo never reaches a drawdown or daily-loss halt.
const R_CHOICES = [-1, -1, -1, -0.5, 0, 0.5, 1, 1, 1.5, 2, 2, 3, -1.5];
const DAY = 86_400_000;

export interface SeedSummary {
  accountId: number;
  closed: number;
  open: number;
  planned: number;
  cancelled: number;
}

export function seedDemo(db: Db, now: Date = new Date()): SeedSummary {
  if (listAccounts(db).length > 0) {
    throw new SeedRefusedError(
      'This database already contains accounts, so nothing was added. Delete the demo file to start again.',
    );
  }
  const rand = random(20260101);
  const iso = (ms: number) => new Date(ms).toISOString();
  const first = now.getTime() - 75 * DAY;

  const account = createAccount(
    db,
    { name: DEMO_ACCOUNT_NAME, baseCurrency: 'USDT', startingBalance: '10000' },
    { now: () => new Date(first - DAY) },
  );
  const setups = ['Breakout', 'Pullback', 'Range fade'].map((name) =>
    createSetup(db, { name, description: `DEMO setup: ${name}` }, () => new Date(first - DAY)),
  );

  const make = (over: Record<string, unknown>, at: number): Trade =>
    createTrade(
      db,
      {
        accountId: account.id,
        assetClass: 'crypto',
        quoteCurrency: 'USDT',
        feesCurrency: 'USDT',
        ...over,
      },
      { now: () => new Date(at) },
    );

  let closed = 0;
  const closedCount = 36;
  for (let i = 0; i < closedCount; i++) {
    const s = SYMBOLS[Math.floor(rand() * SYMBOLS.length)] as (typeof SYMBOLS)[number];
    const long = rand() < 0.65;
    const entry = Math.round(s.price * (0.9 + rand() * 0.2) * 100) / 100;
    const stopDistance = Math.round(entry * (0.01 + rand() * 0.015) * 100) / 100;
    const r = R_CHOICES[Math.floor(rand() * R_CHOICES.length)] as number;
    const stop = long ? entry - stopDistance : entry + stopDistance;
    const exit = long ? entry + r * stopDistance : entry - r * stopDistance;
    const riskMoney = 40 + Math.floor(rand() * 40); // 0.4 % to 0.8 % of 10000
    const size = Math.max(0.0001, riskMoney / stopDistance);
    const openedAt = first + Math.floor((i / closedCount) * 73 * DAY) + 3_600_000 * 8;
    const closedAt = openedAt + 3_600_000 * (3 + Math.floor(rand() * 40));
    const trade = make(
      {
        symbol: s.symbol,
        direction: long ? 'long' : 'short',
        status: 'open',
        plannedEntry: entry.toFixed(2),
        entryPrice: entry.toFixed(2),
        stopLoss: stop.toFixed(2),
        takeProfit: (long ? entry + 2 * stopDistance : entry - 2 * stopDistance).toFixed(2),
        size: size.toFixed(4),
        openedAt: iso(openedAt),
        setupId: (setups[i % setups.length] as { id: number }).id,
        planNotes: 'DEMO trade',
      },
      openedAt,
    );
    closeTrade(
      db,
      trade.id,
      {
        exitPrice: Math.max(0.01, exit).toFixed(2),
        closedAt: iso(closedAt),
        fees: (0.4 + rand() * 1.6).toFixed(2),
        reviewNotes: i % 5 === 0 ? 'DEMO review note: followed the plan.' : '',
        emotion: i % 7 === 0 ? 'calm' : '',
      },
      { now: () => new Date(closedAt) },
    );
    closed += 1;
  }

  // a closed trade quoted in another currency, and one whose fees are in another currency
  const eurAt = now.getTime() - 20 * DAY;
  const eur = make(
    {
      symbol: 'EURUSD',
      assetClass: 'forex',
      quoteCurrency: 'EUR',
      feesCurrency: 'EUR',
      direction: 'long',
      status: 'open',
      plannedEntry: '1.0800',
      entryPrice: '1.0800',
      stopLoss: '1.0700',
      size: '1000',
      openedAt: iso(eurAt),
      planNotes: 'DEMO trade in another currency',
    },
    eurAt,
  );
  closeTrade(
    db,
    eur.id,
    { exitPrice: '1.0900', closedAt: iso(eurAt + 7_200_000) },
    { now: () => new Date(eurAt + 7_200_000) },
  );
  closed += 1;

  const bnbAt = now.getTime() - 9 * DAY;
  const bnb = make(
    {
      symbol: 'BTCUSDT',
      direction: 'long',
      status: 'open',
      plannedEntry: '63000.00',
      entryPrice: '63000.00',
      stopLoss: '62000.00',
      size: '0.05',
      openedAt: iso(bnbAt),
      planNotes: 'DEMO trade with fees in another currency',
    },
    bnbAt,
  );
  closeTrade(
    db,
    bnb.id,
    { exitPrice: '63500.00', closedAt: iso(bnbAt + 7_200_000), fees: '0.01', feesCurrency: 'BNB' },
    { now: () => new Date(bnbAt + 7_200_000) },
  );
  closed += 1;

  // one example OVERRIDE: a demo record only (the real override path needs a fresh code)
  const overAt = now.getTime() - 5 * DAY;
  const over = make(
    {
      symbol: 'SOLUSDT',
      direction: 'long',
      status: 'planned',
      plannedEntry: '150.00',
      stopLoss: '140.00',
      size: '25',
      planNotes: 'DEMO: logged although it broke the per-trade limit',
    },
    overAt,
  );
  db.insert(riskVerdicts)
    .values({
      tradeId: over.id,
      stage: 'created',
      approved: 0,
      violationCodes: JSON.stringify(['MAX_RISK_PER_TRADE']),
      warningCodes: '[]',
      snapshotJson: JSON.stringify({
        approved: false,
        violations: [
          {
            code: 'MAX_RISK_PER_TRADE',
            message: 'DEMO example: the risk of this plan was above the per-trade limit.',
          },
        ],
        warnings: [],
        numbers: { riskAmount: '250', riskLimitAmount: '100' },
      }),
      overrideReason: 'DEMO example of an override reason',
      createdAt: iso(overAt),
    })
    .run();
  appendRiskEvent(db, {
    accountId: account.id,
    kind: 'override',
    tradeId: over.id,
    reason: 'DEMO example of an override reason',
    details: { stage: 'created', codes: ['MAX_RISK_PER_TRADE'] },
    at: new Date(overAt),
  });

  // open and planned and cancelled trades (small risk: inside every limit)
  const openAt = now.getTime() - 2 * 3_600_000;
  make(
    {
      symbol: 'BTCUSDT',
      direction: 'long',
      status: 'open',
      plannedEntry: '64000.00',
      entryPrice: '64000.00',
      stopLoss: '63000.00',
      takeProfit: '66500.00',
      size: '0.05',
      openedAt: iso(openAt),
      setupId: (setups[0] as { id: number }).id,
      planNotes: 'DEMO open trade',
    },
    openAt,
  );
  make(
    {
      symbol: 'ETHUSDT',
      direction: 'short',
      status: 'open',
      plannedEntry: '3100.00',
      entryPrice: '3100.00',
      stopLoss: '3160.00',
      takeProfit: '2950.00',
      size: '0.8',
      openedAt: iso(openAt - 3_600_000),
      setupId: (setups[1] as { id: number }).id,
      planNotes: 'DEMO open trade',
    },
    openAt,
  );
  make(
    {
      symbol: 'SOLUSDT',
      direction: 'long',
      status: 'planned',
      plannedEntry: '140.00',
      stopLoss: '135.00',
      takeProfit: '155.00',
      size: '10',
      planNotes: 'DEMO planned trade',
    },
    now.getTime() - 3_600_000,
  );
  const cancelled = make(
    {
      symbol: 'ETHUSDT',
      direction: 'long',
      status: 'planned',
      plannedEntry: '3000.00',
      stopLoss: '2900.00',
      size: '0.5',
      planNotes: 'DEMO cancelled plan',
    },
    now.getTime() - 4 * DAY,
  );
  cancelTrade(db, cancelled.id, { now: () => new Date(now.getTime() - 3 * DAY) });

  return { accountId: account.id, closed, open: 2, planned: 2, cancelled: 1 };
}

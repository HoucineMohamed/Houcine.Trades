import { and, asc, eq, inArray } from 'drizzle-orm';
import { getAccount } from '@/data/accounts';
import type { Reader } from '@/data/client';
import { getTradeRiskFlags } from '@/data/journal';
import { evaluatePlanForAccount, getRiskSettingsView } from '@/data/risk';
import { trades } from '@/data/schema';
import { getSetup } from '@/data/setups';
import { loadStatsInput } from '@/data/stats';
import {
  factsFromGroupStats,
  factsFromRiskSettings,
  factsFromTradeResult,
  factsFromVerdictNumbers,
  type PlanReviewFacts,
  type TradeFacts,
  type TutorFacts,
  type WeeklyReviewFacts,
} from '@/domain/analyst';
import type { TradePlan } from '@/domain/risk';
import { isDecimalString } from '@/domain/money/decimal';
import { safeToken } from '@/domain/analyst';
import { computeAccountStats } from '@/domain/stats';

/**
 * Loads what each feature sends to the AI, as plain facts. It only LOADS and LABELS values that
 * the risk engine, the stats engine and the journal already produced (project rule 3): nothing is
 * calculated here, and the verdict is always recomputed on the server (a client cannot supply one).
 */

export type Loaded<T> = { ok: true; facts: T } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export interface PlanReviewRequest {
  accountId: number;
  plan: TradePlan;
  setupId: number | null;
  planNotes: string;
  emotion: string;
}

export function loadPlanReviewFacts(
  db: Reader,
  r: PlanReviewRequest,
  now: Date,
): Loaded<PlanReviewFacts> {
  const account = getAccount(db, r.accountId);
  if (!account) return fail('Choose an account first.');
  const rules = getRiskSettingsView(db, r.accountId, now);
  if (rules.effective === null) {
    return fail('The saved risk settings could not be read, so the plan cannot be reviewed.');
  }
  const { verdict } = evaluatePlanForAccount(db, r.accountId, r.plan, now);
  const setupName = r.setupId === null ? null : (getSetup(db, r.setupId)?.name ?? null);
  // The plan comes from the browser: only well-formed numbers and tokens go into the prompt.
  const number = (v: string | null): string | null =>
    v !== null && isDecimalString(v.trim()) ? v.trim() : null;
  const badNumbers = [r.plan.entry, r.plan.stop, r.plan.target, r.plan.size].some(
    (v) => v !== null && v.trim() !== '' && number(v) === null,
  );
  return {
    ok: true,
    facts: {
      symbol: r.plan.symbol,
      plan: [
        {
          key: 'direction',
          value:
            r.plan.direction === 'short'
              ? 'short'
              : r.plan.direction === 'long'
                ? 'long'
                : 'invalid',
        },
        { key: 'entry price', value: number(r.plan.entry), figure: true },
        { key: 'stop-loss', value: number(r.plan.stop), figure: true },
        { key: 'take-profit', value: number(r.plan.target), figure: true },
        { key: 'size', value: number(r.plan.size), figure: true },
        { key: 'quote currency', value: safeToken(r.plan.quoteCurrency, 10) },
        { key: 'account base currency', value: safeToken(account.baseCurrency, 10) },
        ...(badNumbers
          ? [
              {
                key: 'note',
                value: 'a price or size in the plan was not a valid number and is shown as n/a',
              },
            ]
          : []),
      ],
      setupName,
      planNotes: r.planNotes,
      emotion: r.emotion,
      verdict: {
        approved: verdict.approved,
        violations: verdict.violations.map((v) => `${v.code}: ${v.message}`),
        warnings: verdict.warnings.map((w) => `${w.code}: ${w.message}`),
      },
      verdictNumbers: factsFromVerdictNumbers(verdict.numbers),
      riskRules: factsFromRiskSettings(rules.effective),
    },
  };
}

// ---- weekly review ------------------------------------------------------------------------------

export const MAX_RANGE_DAYS = 366;
const DAY = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const utcStart = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

export interface WeeklyRequest {
  accountId: number;
  from: string;
  to: string;
  currency: string;
}

export function loadWeeklyFacts(db: Reader, r: WeeklyRequest): Loaded<WeeklyReviewFacts> {
  if (
    !DATE.test(r.from) ||
    !DATE.test(r.to) ||
    Number.isNaN(utcStart(r.from)) ||
    Number.isNaN(utcStart(r.to))
  ) {
    return fail('Choose a start date and an end date.');
  }
  if (utcStart(r.from) > utcStart(r.to))
    return fail('The start date must not be after the end date.');
  if ((utcStart(r.to) - utcStart(r.from)) / DAY >= MAX_RANGE_DAYS) {
    return fail(`The range can be at most ${MAX_RANGE_DAYS} days.`);
  }
  const currency = r.currency.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(currency)) return fail('Choose a currency.');
  if (!getAccount(db, r.accountId)) return fail('Choose an account first.');

  const startMs = utcStart(r.from);
  const endMs = utcStart(r.to) + DAY; // the end date is included
  const input = loadStatsInput(db, r.accountId);
  const inRange = input.trades.filter((t) => {
    const at = t.closedAt ? Date.parse(t.closedAt) : Number.NaN;
    return !Number.isNaN(at) && at >= startMs && at < endMs;
  });
  const stats = computeAccountStats({ ...input, trades: inRange });
  const c = stats.currencies.find((x) => x.quoteCurrency === currency);
  if (!c || c.tradeResults.length === 0) {
    return fail(`There are no closed trades in ${currency} between those dates.`);
  }
  const ids = c.tradeResults.map((t) => t.tradeId);
  const rows = db
    .select()
    .from(trades)
    .where(and(eq(trades.accountId, r.accountId), inArray(trades.id, ids)))
    .orderBy(asc(trades.closedAt), asc(trades.id))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const flags = getTradeRiskFlags(db);
  const setupNames = new Map(inRange.map((t) => [t.id, t.setupName]));

  const tradeFacts: TradeFacts[] = [];
  for (const res of c.tradeResults) {
    const row = byId.get(res.tradeId);
    if (!row) continue;
    tradeFacts.push({
      id: row.id,
      symbol: row.symbol,
      direction: row.direction,
      closedAt: row.closedAt,
      figures: factsFromTradeResult(res),
      overridden: flags.get(row.id)?.overridden ?? false,
      setupName: setupNames.get(row.id) ?? null,
      emotion: row.emotion,
      planNotes: row.planNotes,
      reviewNotes: row.reviewNotes,
    });
  }
  return {
    ok: true,
    facts: {
      from: r.from,
      to: r.to,
      currency,
      stats: [
        ...factsFromGroupStats(c.overall),
        {
          key: 'closed trades the stats engine could not use',
          value: c.skipped.length,
          figure: true,
        },
      ],
      sampleWarning: c.overall.sampleSize.warning,
      trades: tradeFacts,
      overrideCount: tradeFacts.filter((t) => t.overridden).length,
    },
  };
}

// ---- tutor ----------------------------------------------------------------------------------------

export function loadTutorFacts(db: Reader, question: string, accountId: number | null): TutorFacts {
  if (accountId === null || !getAccount(db, accountId)) {
    return { question, currency: null, metrics: [] };
  }
  const stats = computeAccountStats(loadStatsInput(db, accountId));
  const c = stats.currencies.find((x) => x.overall.tradeCount > 0);
  if (!c) return { question, currency: null, metrics: [] };
  return { question, currency: c.quoteCurrency, metrics: factsFromGroupStats(c.overall) };
}

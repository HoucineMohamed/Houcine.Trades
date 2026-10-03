import { eq } from 'drizzle-orm';
import {
  evaluatePlan,
  validateOverride,
  type RiskContext,
  type TradePlan,
  type Verdict,
} from '@/domain/risk';
import * as lifecycle from '@/domain/trades/lifecycle';
import type { RepoOptions } from './accounts';
import type { Db, Reader, Writer } from './client';
import { NotFoundError } from './errors';
import { syncRiskState, syncRiskStateIn } from './risk';
import { appendRiskEvent } from './risk-events';
import { riskVerdicts, trades } from './schema';
import { closeTrade, createTradeIn, openTradeIn, type Trade } from './trades';

/**
 * The journal: how trades enter and change state WITH the risk engine's verdict.
 *
 * - A plan the engine APPROVES is saved together with its verdict snapshot.
 * - A plan it REFUSES is not saved. A refusal event is logged.
 * - A refused plan may still be LOGGED (journal honesty: you may have taken the trade, or want to
 *   study it) but only with the typed word OVERRIDE and a reason (at least 10 characters). The
 *   trade is then saved with a refused verdict, the reason, and an override event.
 *
 * REAL ORDER EXECUTION (a later module) HAS NO OVERRIDE: nothing here can place an order, and
 * `requireApprovedForExecution` in the domain refuses anything that is not a clean approval.
 */

export class RiskRefusalError extends Error {
  readonly verdict: Verdict;
  constructor(verdict: Verdict) {
    super(
      `Refused by the risk engine: ${verdict.violations.map((v) => v.message).join(' ')} ` +
        'To log it anyway, type OVERRIDE and give a reason.',
    );
    this.name = 'RiskRefusalError';
    this.verdict = verdict;
  }
}

export interface JournalOptions extends RepoOptions {
  /** Typed confirmation + reason to log a plan the engine refused. */
  override?: { confirm?: string | null; reason?: string | null } | null;
}

export interface JournalResult {
  trade: Trade;
  verdict: Verdict;
  overridden: boolean;
}

const nowOf = (options: JournalOptions) => (options.now ?? (() => new Date()))();

const wantsOverride = (o: JournalOptions['override']) =>
  !!o && ((o.confirm ?? '').trim() !== '' || (o.reason ?? '').trim() !== '');

function insertVerdict(
  tx: Writer,
  args: {
    tradeId: number;
    stage: 'created' | 'opened';
    verdict: Verdict;
    context: RiskContext;
    overrideReason: string | null;
    at: Date;
  },
) {
  tx.insert(riskVerdicts)
    .values({
      tradeId: args.tradeId,
      stage: args.stage,
      approved: args.verdict.approved ? 1 : 0,
      violationCodes: JSON.stringify(args.verdict.violations.map((v) => v.code)),
      warningCodes: JSON.stringify(args.verdict.warnings.map((w) => w.code)),
      snapshotJson: JSON.stringify({
        ...args.verdict,
        settings: args.context.settings,
        halts: args.context.halts.map((h) => h.kind),
      }),
      overrideReason: args.overrideReason,
      createdAt: args.at.toISOString(),
    })
    .run();
}

/**
 * Shared gate: evaluates the plan; returns the verdict and the override reason (null when the
 * plan is approved). Logs a refusal when there is no override. Throws ValidationError when an
 * override is attempted but the typed confirmation or reason is wrong.
 */
function gate(
  tx: Writer,
  args: {
    accountId: number;
    plan: TradePlan;
    stage: 'created' | 'opened';
    options: JournalOptions;
    now: Date;
  },
):
  { refused: Verdict } | { verdict: Verdict; context: RiskContext; overrideReason: string | null } {
  const context = syncRiskStateIn(tx, args.accountId, args.now);
  const verdict = evaluatePlan(args.plan, context);
  if (verdict.approved) return { verdict, context, overrideReason: null };
  if (!wantsOverride(args.options.override)) {
    appendRiskEvent(tx, {
      accountId: args.accountId,
      kind: 'plan_refused',
      reason: verdict.violations.map((v) => v.code).join(', '),
      details: {
        stage: args.stage,
        plan: args.plan,
        codes: verdict.violations.map((v) => v.code),
        numbers: verdict.numbers,
      },
      at: args.now,
    });
    return { refused: verdict };
  }
  return { verdict, context, overrideReason: validateOverride(args.options.override ?? {}).reason };
}

/** Logs a new trade (planned or already open) through the risk engine. */
export function logTrade(db: Db, input: unknown, options: JournalOptions = {}): JournalResult {
  const fields = lifecycle.buildNewTrade(input); // malformed input is a ValidationError, not a risk question
  const now = nowOf(options);
  const plan: TradePlan = {
    symbol: fields.symbol,
    direction: fields.direction,
    entry: fields.status === 'open' ? fields.entryPrice : fields.plannedEntry,
    stop: fields.stopLoss,
    target: fields.takeProfit,
    size: fields.size,
    quoteCurrency: fields.quoteCurrency,
  };
  const outcome = db.transaction((tx) => {
    const g = gate(tx, { accountId: fields.accountId, plan, stage: 'created', options, now });
    if ('refused' in g) return g;
    const trade = createTradeIn(tx, input, { ...options, now: () => now });
    insertVerdict(tx, {
      tradeId: trade.id,
      stage: 'created',
      verdict: g.verdict,
      context: g.context,
      overrideReason: g.overrideReason,
      at: now,
    });
    if (g.overrideReason !== null) {
      appendRiskEvent(tx, {
        accountId: fields.accountId,
        kind: 'override',
        tradeId: trade.id,
        reason: g.overrideReason,
        details: { stage: 'created', codes: g.verdict.violations.map((v) => v.code) },
        at: now,
      });
    }
    return {
      trade,
      verdict: g.verdict,
      overridden: g.overrideReason !== null,
    } satisfies JournalResult;
  });
  // Thrown AFTER the transaction committed, so the refusal event is kept.
  if ('refused' in outcome) throw new RiskRefusalError(outcome.refused);
  return outcome;
}

/** planned -> open through the risk engine (the real entry price is judged against the rules). */
export function openTradeChecked(
  db: Db,
  tradeId: number,
  input: unknown,
  options: JournalOptions = {},
): JournalResult {
  const now = nowOf(options);
  const outcome = db.transaction((tx) => {
    const current = tx.select().from(trades).where(eq(trades.id, tradeId)).get();
    if (!current) throw new NotFoundError(`Trade ${tradeId}`);
    const next = lifecycle.openTrade(current, input); // validates the move and the real entry price
    const plan: TradePlan = {
      symbol: next.symbol,
      direction: next.direction,
      entry: next.entryPrice,
      stop: next.stopLoss,
      target: next.takeProfit,
      size: next.size,
      quoteCurrency: next.quoteCurrency,
    };
    const g = gate(tx, { accountId: current.accountId, plan, stage: 'opened', options, now });
    if ('refused' in g) return g;
    const trade = openTradeIn(tx, tradeId, input, { ...options, now: () => now });
    insertVerdict(tx, {
      tradeId,
      stage: 'opened',
      verdict: g.verdict,
      context: g.context,
      overrideReason: g.overrideReason,
      at: now,
    });
    if (g.overrideReason !== null) {
      appendRiskEvent(tx, {
        accountId: current.accountId,
        kind: 'override',
        tradeId,
        reason: g.overrideReason,
        details: { stage: 'opened', codes: g.verdict.violations.map((v) => v.code) },
        at: now,
      });
    }
    return {
      trade,
      verdict: g.verdict,
      overridden: g.overrideReason !== null,
    } satisfies JournalResult;
  });
  if ('refused' in outcome) throw new RiskRefusalError(outcome.refused);
  return outcome;
}

/**
 * Closes a trade. Closing is NEVER blocked by risk rules (it only reduces risk). Afterwards the
 * risk state is synced so a halt caused by this close is latched immediately.
 */
export function closeTradeAndSync(
  db: Db,
  id: number,
  input: unknown,
  options: RepoOptions = {},
): Trade {
  const trade = closeTrade(db, id, input, options);
  syncRiskState(db, trade.accountId, (options.now ?? (() => new Date()))());
  return trade;
}

// ---- reading verdicts --------------------------------------------------------------------

export interface TradeRiskFlags {
  /** True when any stage of this trade was logged with an override. */
  overridden: boolean;
  overrideReasons: string[];
  violationCodes: string[];
}

/** Risk flags per trade id (for the journal list). */
export function getTradeRiskFlags(db: Reader): Map<number, TradeRiskFlags> {
  const flags = new Map<number, TradeRiskFlags>();
  for (const v of db.select().from(riskVerdicts).all()) {
    const f = flags.get(v.tradeId) ?? {
      overridden: false,
      overrideReasons: [],
      violationCodes: [],
    };
    if (v.overrideReason) {
      f.overridden = true;
      f.overrideReasons.push(v.overrideReason);
    }
    for (const code of JSON.parse(v.violationCodes) as string[])
      if (!f.violationCodes.includes(code)) f.violationCodes.push(code);
    flags.set(v.tradeId, f);
  }
  return flags;
}

export function listVerdicts(db: Reader, tradeId: number) {
  return db.select().from(riskVerdicts).where(eq(riskVerdicts.tradeId, tradeId)).all();
}

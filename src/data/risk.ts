import { and, asc, eq, inArray } from 'drizzle-orm';
import { ValidationError } from '@/domain/errors';
import {
  buildRiskContext,
  evaluatePlan,
  parsePendingJson,
  parseSettingsJson,
  requestSettingsChange,
  RISK_DEFAULTS,
  settleSettings,
  validateHaltReason,
  validateReset,
  type HaltKind,
  type PendingMap,
  type RiskContext,
  type RiskEventRecord,
  type RiskSettings,
  type SettingsChangeResult,
  type TradePlan,
  type Verdict,
} from '@/domain/risk';
import { computeAccountStats } from '@/domain/stats';
import { getAccount } from './accounts';
import type { Db, Reader, Writer } from './client';
import { NotFoundError } from './errors';
import { appendRiskEvent, parseDetails } from './risk-events';
import { riskEvents, riskSettings, trades } from './schema';
import { loadStatsInput } from './stats';

/**
 * Risk data access. Everything here only LOADS facts and STORES events/settings; the decisions
 * (equity, halts, verdicts) are made by the pure code in src/domain/risk. State is always derived
 * from the trades and the append-only event log, so nothing is lost by a restart.
 */

// ---- loading the context (read only) ------------------------------------------------------

/** Loads everything the risk engine needs and builds the context. Writes nothing. */
export function loadRiskContext(
  db: Reader,
  accountId: number,
  now: Date = new Date(),
): RiskContext {
  const account = getAccount(db, accountId);
  if (!account) {
    return buildRiskContext({
      now,
      account: null,
      baseStats: null,
      recordedClosedAt: {},
      openTrades: [],
      events: [],
      settingsJson: null,
      pendingJson: null,
    });
  }
  const stats = computeAccountStats(loadStatsInput(db, accountId));
  const baseStats = stats.currencies.find((c) => c.quoteCurrency === account.baseCurrency) ?? null;

  const recordedClosedAt: Record<number, string | null> = {};
  for (const row of db
    .select({ id: trades.id, recorded: trades.closedRecordedAt })
    .from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.status, 'closed')))
    .all()) {
    recordedClosedAt[row.id] = row.recorded;
  }

  const openTrades = db
    .select({
      tradeId: trades.id,
      quoteCurrency: trades.quoteCurrency,
      entryPrice: trades.entryPrice,
      initialStopLoss: trades.initialStopLoss,
      size: trades.size,
    })
    .from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.status, 'open')))
    .all();

  const events: RiskEventRecord[] = db
    .select()
    .from(riskEvents)
    .where(and(eq(riskEvents.accountId, accountId), inArray(riskEvents.kind, ['halt', 'reset'])))
    .orderBy(asc(riskEvents.id))
    .all()
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      haltKind: e.haltKind,
      createdAt: e.createdAt,
      details: parseDetails(e.detailsJson),
    }));

  const settings = db
    .select()
    .from(riskSettings)
    .where(eq(riskSettings.accountId, accountId))
    .get();
  return buildRiskContext({
    now,
    account: { baseCurrency: account.baseCurrency, startingBalance: account.startingBalance },
    baseStats,
    recordedClosedAt,
    openTrades,
    events,
    settingsJson: settings?.settingsJson ?? null,
    pendingJson: settings?.pendingJson ?? null,
  });
}

/**
 * Loads the context AND records what needs recording: halts that were detected but not yet
 * logged, and loosened settings whose 24 hours have passed. Idempotent. Call it from every path
 * that acts on the account (attempts to log a trade, closing a trade, settings changes, the
 * /risk page) so a halt is latched as early as possible.
 */
export function syncRiskStateIn(
  tx: Writer,
  accountId: number,
  now: Date = new Date(),
): RiskContext {
  const ctx = loadRiskContext(tx, accountId, now);
  if (!ctx.accountKnown) return ctx;
  for (const e of ctx.newHaltEvents) {
    appendRiskEvent(tx, {
      accountId,
      kind: 'halt',
      haltKind: e.kind,
      reason: e.kind === 'drawdown' ? 'Drawdown limit reached' : 'Daily-loss limit reached',
      details: e.details,
      at: now,
    });
  }
  if (ctx.becameEffective.length > 0) {
    const row = tx.select().from(riskSettings).where(eq(riskSettings.accountId, accountId)).get();
    const active = parseSettingsJson(row?.settingsJson);
    const pending = parsePendingJson(row?.pendingJson);
    if (row && active.ok && pending.ok) {
      const settled = settleSettings(active.settings, pending.pending, now);
      tx.update(riskSettings)
        .set({
          settingsJson: JSON.stringify(settled.settings),
          pendingJson: JSON.stringify(settled.stillPending),
          updatedAt: now.toISOString(),
        })
        .where(eq(riskSettings.accountId, accountId))
        .run();
      appendRiskEvent(tx, {
        accountId,
        kind: 'settings_applied',
        reason: 'A loosened setting became effective after its 24 hour delay',
        details: { changes: settled.becameEffective },
        at: now,
      });
    }
  }
  return ctx;
}

export function syncRiskState(db: Db, accountId: number, now: Date = new Date()): RiskContext {
  return db.transaction((tx) => syncRiskStateIn(tx, accountId, now));
}

// ---- evaluating plans ---------------------------------------------------------------------

/** Evaluates a plan against the real account state. Read only (used for the live preview). */
export function evaluatePlanForAccount(
  db: Reader,
  accountId: number,
  plan: TradePlan,
  now: Date = new Date(),
): { verdict: Verdict; context: RiskContext } {
  const context = loadRiskContext(db, accountId, now);
  return { verdict: evaluatePlan(plan, context), context };
}

// ---- settings -----------------------------------------------------------------------------

export interface RiskSettingsView {
  /** Settings stored as active (before any pending change takes effect). */
  active: RiskSettings | null;
  /** The settings in force right now (active + pending changes that are already due). */
  effective: RiskSettings | null;
  pending: PendingMap;
  problem: string | null;
}

export function getRiskSettingsView(
  db: Reader,
  accountId: number,
  now: Date = new Date(),
): RiskSettingsView {
  const row = db.select().from(riskSettings).where(eq(riskSettings.accountId, accountId)).get();
  const active = parseSettingsJson(row?.settingsJson);
  const pending = parsePendingJson(row?.pendingJson);
  if (!active.ok) return { active: null, effective: null, pending: {}, problem: active.problem };
  if (!pending.ok)
    return { active: active.settings, effective: null, pending: {}, problem: pending.problem };
  const settled = settleSettings(active.settings, pending.pending, now);
  return {
    active: active.settings,
    effective: settled.settings,
    pending: settled.stillPending,
    problem: null,
  };
}

/**
 * Submits a settings change. Tightening applies now; loosening becomes effective after 24 hours.
 * Values above a hard ceiling are rejected (ValidationError). Every change is logged.
 */
export function updateRiskSettings(
  db: Db,
  accountId: number,
  requested: Record<string, unknown>,
  now: Date = new Date(),
): SettingsChangeResult {
  return db.transaction((tx) => {
    syncRiskStateIn(tx, accountId, now); // latch halts and apply due changes BEFORE changing anything
    const row = tx.select().from(riskSettings).where(eq(riskSettings.accountId, accountId)).get();
    if (!row) throw new NotFoundError(`Risk settings for account ${accountId}`);
    const active = parseSettingsJson(row.settingsJson);
    const pending = parsePendingJson(row.pendingJson);
    if (!active.ok || !pending.ok) {
      throw new ValidationError([
        {
          field: '',
          message: `The stored risk settings are corrupt (${active.ok ? (pending as { problem: string }).problem : active.problem}). Restore the defaults first.`,
        },
      ]);
    }
    const result = requestSettingsChange(active.settings, pending.pending, requested, now);
    tx.update(riskSettings)
      .set({
        settingsJson: JSON.stringify(result.active),
        pendingJson: JSON.stringify(result.pending),
        updatedAt: now.toISOString(),
      })
      .where(eq(riskSettings.accountId, accountId))
      .run();
    appendRiskEvent(tx, {
      accountId,
      kind: 'settings_change',
      reason: 'Risk settings submitted',
      details: {
        applied: result.applied,
        deferred: result.deferred,
        cancelled: result.cancelled,
        unchanged: result.unchanged,
      },
      at: now,
    });
    return result;
  });
}

/** Recovery for corrupt stored settings: writes the defaults back (typed confirmation + reason). */
export function restoreDefaultRiskSettings(
  db: Db,
  accountId: number,
  input: { confirm?: string | null; reason?: string | null },
  now: Date = new Date(),
): void {
  const { reason } = validateReset(input);
  db.transaction((tx) => {
    if (!getAccount(tx, accountId)) throw new NotFoundError(`Account ${accountId}`);
    tx.insert(riskSettings)
      .values({
        accountId,
        settingsJson: JSON.stringify(RISK_DEFAULTS),
        pendingJson: '{}',
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: riskSettings.accountId,
        set: {
          settingsJson: JSON.stringify(RISK_DEFAULTS),
          pendingJson: '{}',
          updatedAt: now.toISOString(),
        },
      })
      .run();
    appendRiskEvent(tx, {
      accountId,
      kind: 'settings_change',
      reason,
      details: { restoredDefaults: true },
      at: now,
    });
  });
}

// ---- halts ---------------------------------------------------------------------------------

/** The kill switch: halts trading until you reset it. Needs a short reason. */
export function haltManually(
  db: Db,
  accountId: number,
  reason: string,
  now: Date = new Date(),
): void {
  const text = validateHaltReason(reason);
  db.transaction((tx) => {
    const ctx = syncRiskStateIn(tx, accountId, now);
    if (!ctx.accountKnown) throw new NotFoundError(`Account ${accountId}`);
    if (ctx.halts.some((h) => h.kind === 'manual')) {
      throw new ValidationError([{ field: '', message: 'Trading is already halted manually.' }]);
    }
    appendRiskEvent(tx, {
      accountId,
      kind: 'halt',
      haltKind: 'manual',
      reason: text,
      details: { reason: text },
      at: now,
    });
  });
}

const formatRemaining = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
};
export { formatRemaining };

/**
 * Resets a manual or drawdown halt. Needs the typed word RESET and a reason (>= 10 characters).
 * - A manual halt can be reset at once.
 * - A DRAWDOWN halt can only be reset 24 hours after it began. A refused attempt is logged.
 * - A drawdown reset records your current equity as the new baseline: drawdown is measured from
 *   there afterwards (otherwise the halt would trigger again immediately).
 * A daily-loss halt cannot be reset: it clears at the next UTC midnight.
 */
export function resetHalt(
  db: Db,
  accountId: number,
  kind: Extract<HaltKind, 'manual' | 'drawdown'>,
  input: { confirm?: string | null; reason?: string | null },
  now: Date = new Date(),
): void {
  const { reason } = validateReset(input);
  const outcome = db.transaction((tx): { refused: string } | { done: true } => {
    const ctx = syncRiskStateIn(tx, accountId, now);
    if (!ctx.accountKnown) throw new NotFoundError(`Account ${accountId}`);
    const halt = ctx.halts.find((h) => h.kind === kind);
    if (!halt) {
      throw new ValidationError([
        { field: '', message: `There is no active ${kind} halt to reset.` },
      ]);
    }
    const refuse = (message: string, details: Record<string, unknown>) => {
      appendRiskEvent(tx, {
        accountId,
        kind: 'reset_refused',
        haltKind: kind,
        reason,
        details: { message, ...details },
        at: now,
      });
      return { refused: message };
    };
    if (kind === 'drawdown' && !halt.resetAllowedNow) {
      return refuse(
        `A drawdown halt can only be reset 24 hours after it began. You can reset it at ${halt.resetAvailableAt} (in ${formatRemaining(halt.resetRemainingMs ?? 0)}).`,
        {
          availableAt: halt.resetAvailableAt,
          remainingMs: halt.resetRemainingMs,
          since: halt.since,
        },
      );
    }
    if (kind === 'drawdown' && ctx.equity === null) {
      return refuse(
        `The drawdown halt cannot be reset while equity cannot be verified (${ctx.equityProblem ?? 'unknown problem'}).`,
        { equityProblem: ctx.equityProblem },
      );
    }
    appendRiskEvent(tx, {
      accountId,
      kind: 'reset',
      haltKind: kind,
      reason,
      details:
        kind === 'drawdown'
          ? {
              reason,
              baselineEquity: ctx.equity,
              previousPeakEquity: ctx.peakEquity,
              haltBeganAt: halt.since,
              resetAt: now.toISOString(),
            }
          : { reason, haltBeganAt: halt.since, resetAt: now.toISOString() },
      at: now,
    });
    return { done: true };
  });
  // Thrown AFTER the transaction committed, so the refusal event is kept.
  if ('refused' in outcome) throw new ValidationError([{ field: '', message: outcome.refused }]);
}

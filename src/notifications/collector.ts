import 'server-only';
import { and, eq, gt, gte } from 'drizzle-orm';
import { getAiSettings, getUsageTotals } from '@/data/analyst';
import { listAccounts } from '@/data/accounts';
import type { Db, Reader, Writer } from '@/data/client';
import {
  BASELINE_AT_KEY,
  currentMaxIds,
  insertEvents,
  readAllState,
  writeStates,
} from '@/data/notifications';
import { loadRiskContext } from '@/data/risk';
import { aiUsage, authEvents, riskEvents, riskVerdicts, trades } from '@/data/schema';
import {
  baselineLimitState,
  eventFromAnalystUsage,
  eventFromAuthEvent,
  eventFromRiskEvent,
  eventFromVerdict,
  haltClearedEvents,
  levelFromCap,
  levelFromShare,
  loginBurstEvents,
  makeEvent,
  NOTIFY_LIMITS,
  parseLimitState,
  stepLimit,
  utcDayKey,
  utcMonthKey,
  type Level,
  type NotificationEvent,
  type UsageKind,
} from '@/domain/notifications';
import { computeRiskUsage } from '@/domain/risk';

/**
 * Reads NEW rows of the existing logs and the current usage of the limits, and records notification
 * events. READ-ONLY with respect to everything else: it uses the same read functions the pages use
 * (`loadRiskContext`, `computeRiskUsage`, `getUsageTotals`) and writes only the notification tables.
 * No risk, auth or analyst code emits anything; nothing here is called from a trade, a halt or a login.
 *
 * Every section is independent: a problem in one is reported and skipped, never thrown, and its
 * bookkeeping is not advanced (so nothing is lost: it is looked at again next time).
 */

interface Observation {
  stateKey: string;
  kind: UsageKind;
  accountId: number | null;
  observed: Level | null;
  periodKey: string;
}

const WM = { risk: 'wm:risk', verdict: 'wm:verdict', auth: 'wm:auth', usage: 'wm:usage' } as const;

/** The current level of every limit we announce (per account, plus the analyst caps). */
function observeLimits(
  db: Reader,
  now: Date,
  problems: string[],
): { obs: Observation[]; halts: Map<number, string[]> } {
  const obs: Observation[] = [];
  const halts = new Map<number, string[]>();
  const day = utcDayKey(now);
  const month = utcMonthKey(now);
  try {
    for (const account of listAccounts(db)) {
      try {
        const ctx = loadRiskContext(db, account.id, now); // read only
        if (!ctx.accountKnown) {
          problems.push(`account_unknown_${account.id}`);
          continue;
        }
        const usage = computeRiskUsage(ctx);
        const add = (kind: UsageKind, level: Level | null, periodKey: string) =>
          obs.push({
            stateKey: `limit:${kind}:${account.id}`,
            kind,
            accountId: account.id,
            observed: level,
            periodKey,
          });
        add(
          'daily_loss_usage',
          levelFromShare(usage.dailyLoss.shareOfLimit, usage.dailyLoss.reached),
          day,
        );
        add(
          'open_risk_usage',
          levelFromShare(usage.openRisk.shareOfLimit, usage.openRisk.reached),
          'always',
        );
        add(
          'open_trades_usage',
          levelFromShare(usage.openTrades.shareOfLimit, usage.openTrades.reached),
          'always',
        );
        add(
          'drawdown_usage',
          levelFromShare(usage.drawdown.shareOfLimit, usage.drawdown.reached),
          'always',
        );
        halts.set(
          account.id,
          ctx.halts.map((h) => h.kind),
        );
      } catch {
        problems.push(`risk_usage_account_${account.id}`);
      }
    }
  } catch {
    problems.push('accounts');
  }
  try {
    const settings = getAiSettings(db, now);
    if (settings.problem !== null || !settings.effective) {
      problems.push('analyst_settings');
    } else {
      const totals = getUsageTotals(db, now);
      // only "nearly reached" (80) and "reached" (100) are announced for the analyst
      const clamp = (l: Level | null): Level | null => (l === 50 ? 0 : l);
      const add = (kind: UsageKind, level: Level | null, periodKey: string) =>
        obs.push({
          stateKey: `limit:${kind}`,
          kind,
          accountId: null,
          observed: clamp(level),
          periodKey,
        });
      add(
        'analyst_daily_calls_usage',
        levelFromCap(totals.callsToday, settings.effective.dailyCalls),
        day,
      );
      add(
        'analyst_monthly_calls_usage',
        levelFromCap(totals.callsThisMonth, settings.effective.monthlyCalls),
        month,
      );
      add(
        'analyst_monthly_cost_usage',
        levelFromCap(totals.costThisMonthUsd, settings.effective.monthlyCostUsd),
        month,
      );
    }
  } catch {
    problems.push('analyst_usage');
  }
  return { obs, halts };
}

/**
 * What to remember when alerts are switched ON: where each log ends now and the level every limit is
 * at now, so only things that happen FROM NOW ON are announced (nothing old floods the phone).
 */
export function collectorBaseline(
  db: Reader,
  now: Date,
): { state: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const out: Record<string, string> = {};
  try {
    const ids = currentMaxIds(db);
    out[WM.risk] = String(ids.risk);
    out[WM.verdict] = String(ids.verdict);
    out[WM.auth] = String(ids.auth);
    out[WM.usage] = String(ids.usage);
  } catch {
    problems.push('logs_unreadable');
  }
  let previous: Record<string, string> = {};
  try {
    previous = readAllState(db);
  } catch {
    problems.push('state_unreadable');
  }
  const { obs, halts } = observeLimits(db, now, problems);
  for (const o of obs) {
    const base = baselineLimitState(o.observed, o.periodKey);
    // The epoch continues from the last switch-on: a new baseline must never reuse an old dedupe key.
    const before = parseLimitState(previous[o.stateKey]);
    out[o.stateKey] = JSON.stringify(before ? { ...base, epoch: before.epoch + 1 } : base);
  }
  for (const [id, kinds] of halts) out[`halts:${id}`] = JSON.stringify(kinds);
  return { state: out, problems };
}

export interface CollectReport {
  recorded: number;
  /** Short codes of sections that could not be read this time (they are retried next time). */
  problems: string[];
  /** True when alerts were never switched on, so nothing was collected. */
  notBaselined: boolean;
}

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const asId = (v: string | undefined): number | null =>
  v !== undefined && /^\d+$/.test(v) ? Number(v) : null;

/** One immediate transaction: two collectors at once (worker and button) cannot both record or both advance. */
export function collectEvents(db: Db, now: Date): CollectReport {
  return db.transaction((tx) => collectIn(tx, now), { behavior: 'immediate' });
}

function collectIn(db: Writer, now: Date): CollectReport {
  const problems: string[] = [];
  const state = readAllState(db);
  const wm = {
    risk: asId(state[WM.risk]),
    verdict: asId(state[WM.verdict]),
    auth: asId(state[WM.auth]),
    usage: asId(state[WM.usage]),
  };
  if (wm.risk === null || wm.verdict === null || wm.auth === null || wm.usage === null) {
    return { recorded: 0, problems, notBaselined: true };
  }

  const events: NotificationEvent[] = [];
  const newState: Record<string, string> = {};

  // ---- new rows of the existing logs (each log has its own watermark) --------------------------------
  try {
    const rows = db
      .select()
      .from(riskEvents)
      .where(gt(riskEvents.id, wm.risk))
      .orderBy(riskEvents.id)
      .all();
    for (const r of rows) {
      const e = eventFromRiskEvent({
        id: r.id,
        accountId: r.accountId,
        kind: r.kind,
        haltKind: r.haltKind,
        createdAt: r.createdAt,
      });
      if (e) events.push(e);
    }
    if (rows.length > 0) newState[WM.risk] = String(rows.at(-1)?.id);
  } catch {
    problems.push('risk_events');
  }
  try {
    const rows = db
      .select({
        id: riskVerdicts.id,
        approved: riskVerdicts.approved,
        createdAt: riskVerdicts.createdAt,
        accountId: trades.accountId,
      })
      .from(riskVerdicts)
      .innerJoin(trades, eq(riskVerdicts.tradeId, trades.id))
      .where(gt(riskVerdicts.id, wm.verdict))
      .orderBy(riskVerdicts.id)
      .all();
    for (const r of rows) {
      const e = eventFromVerdict(r);
      if (e) events.push(e);
    }
    if (rows.length > 0) newState[WM.verdict] = String(rows.at(-1)?.id);
  } catch {
    problems.push('risk_verdicts');
  }
  try {
    const rows = db
      .select()
      .from(authEvents)
      .where(gt(authEvents.id, wm.auth))
      .orderBy(authEvents.id)
      .all();
    for (const r of rows) {
      const e = eventFromAuthEvent({ id: r.id, kind: r.kind, createdAt: r.createdAt });
      if (e) events.push(e);
    }
    if (rows.length > 0) newState[WM.auth] = String(rows.at(-1)?.id);
  } catch {
    problems.push('auth_events');
  }
  try {
    const rows = db
      .select()
      .from(aiUsage)
      .where(gt(aiUsage.id, wm.usage))
      .orderBy(aiUsage.id)
      .all();
    for (const r of rows) {
      const e = eventFromAnalystUsage({ id: r.id, status: r.status, createdAt: r.createdAt });
      if (e) events.push(e);
    }
    if (rows.length > 0) newState[WM.usage] = String(rows.at(-1)?.id);
  } catch {
    problems.push('ai_usage');
  }

  // ---- failed-login bursts: recomputed from the log each time (idempotent) ------------------------------
  try {
    // Looked at from alerts-on (older failures are never announced) and at most 24 hours back.
    const floor = now.getTime() - NOTIFY_LIMITS.maxAgeMs;
    const baselineMs = Date.parse(state[BASELINE_AT_KEY] ?? '');
    const since = new Date(
      Math.max(floor, Number.isFinite(baselineMs) ? baselineMs : floor),
    ).toISOString();
    const times = db
      .select({ at: authEvents.createdAt })
      .from(authEvents)
      .where(and(eq(authEvents.kind, 'login_failure'), gte(authEvents.createdAt, since)))
      .all()
      .map((r) => r.at);
    events.push(...loginBurstEvents(times));
  } catch {
    problems.push('login_bursts');
  }

  // ---- limit usage and halts ----------------------------------------------------------------------------
  const { obs, halts } = observeLimits(db, now, problems);
  for (const o of obs) {
    const base = o.accountId === null ? `limit:${o.kind}` : `limit:${o.kind}:${o.accountId}`;
    const step = stepLimit(parseLimitState(state[o.stateKey]), o.observed, o.periodKey, base, now);
    newState[o.stateKey] = JSON.stringify(step.state);
    if (step.announce) {
      events.push(
        makeEvent({
          kind: o.kind,
          dedupeKey: step.announce.dedupeKey,
          occurredAt: now.toISOString(),
          accountId: o.accountId,
          level: step.announce.level,
        }),
      );
    }
  }
  for (const [accountId, kinds] of halts) {
    const key = `halts:${accountId}`;
    let before: string[] | null = null;
    try {
      const parsed: unknown = state[key] ? JSON.parse(state[key] as string) : null;
      before = isStringList(parsed) ? parsed : null;
    } catch {
      before = null;
    }
    if (before) events.push(...haltClearedEvents(accountId, before, kinds, now));
    newState[key] = JSON.stringify(kinds);
  }

  // ---- record events and bookkeeping together (a crash cannot lose or repeat anything) ------------------------
  const recorded = insertEvents(db, events, now);
  writeStates(db, newState, now);
  return { recorded, problems, notBaselined: false };
}

import { desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import {
  AI_CAP_DEFAULTS,
  parseCapsJson,
  parsePendingCapsJson,
  parseStoredOutput,
  requestCapsChange,
  settleCaps,
  utcMonthStart,
  type AiCaps,
  type AiUsageStatus,
  type AnalystKind,
  type AnalystOutput,
  type CapsChangeResult,
  type PendingCaps,
  type UsageTotals,
} from '@/domain/analyst';
import { assertFreshAuth, type FreshAuth } from '@/domain/auth/stepup';
import { ValidationError } from '@/domain/errors';
import { addDecimal } from '@/domain/money/decimal';
import { utcDayStart } from '@/domain/risk/time';
import { appendAuthEvent } from './auth';
import type { Db, Reader, Writer } from './client';
import { aiReviews, aiSettings, aiUsage, type AiReviewRow, type AiUsageRow } from './schema';

/**
 * Analyst data access: the privacy switch and caps, the append-only usage log and the stored
 * reviews. It only LOADS and STORES; the decisions (caps, price, output checks) are made by the
 * pure code in src/domain/analyst. Every read FAILS CLOSED: a problem is reported, never guessed.
 */

export class AiDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiDataError';
  }
}

/** Who did it, for the log (never a secret). */
export interface ActorMeta {
  sessionId?: number;
  ip?: string;
  userAgent?: string;
}

// ---- settings ---------------------------------------------------------------------------------

export interface AiSettingsView {
  /** "Send journal data to the AI". OFF unless the stored row says exactly 1. */
  consent: boolean;
  /** Caps stored as active. Null when the stored value is corrupt (then nothing is sent). */
  active: AiCaps | null;
  /** The caps in force right now (active + pending changes that are already due). */
  effective: AiCaps | null;
  pending: PendingCaps;
  /** Why the settings cannot be trusted, or null. */
  problem: string | null;
  updatedAt: string | null;
}

export function getAiSettings(db: Reader, now: Date = new Date()): AiSettingsView {
  const row = db.select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  if (!row) {
    return {
      consent: false,
      active: { ...AI_CAP_DEFAULTS },
      effective: { ...AI_CAP_DEFAULTS },
      pending: {},
      problem: null,
      updatedAt: null,
    };
  }
  const active = parseCapsJson(row.capsJson);
  const pending = parsePendingCapsJson(row.pendingCapsJson);
  const consent = row.consent === 1;
  if (!active.ok) {
    return {
      consent,
      active: null,
      effective: null,
      pending: {},
      problem: active.problem,
      updatedAt: row.updatedAt,
    };
  }
  if (!pending.ok) {
    return {
      consent,
      active: active.caps,
      effective: null,
      pending: {},
      problem: pending.problem,
      updatedAt: row.updatedAt,
    };
  }
  const settled = settleCaps(active.caps, pending.pending, now);
  return {
    consent,
    active: active.caps,
    effective: settled.caps,
    pending: settled.stillPending,
    problem: null,
    updatedAt: row.updatedAt,
  };
}

function writeSettings(
  tx: Writer,
  values: { consent: boolean; caps: AiCaps; pending: PendingCaps },
  now: Date,
): void {
  const row = {
    id: 1,
    consent: values.consent ? 1 : 0,
    capsJson: JSON.stringify(values.caps),
    pendingCapsJson: JSON.stringify(values.pending),
    updatedAt: now.toISOString(),
  };
  tx.insert(aiSettings)
    .values(row)
    .onConflictDoUpdate({
      target: aiSettings.id,
      set: {
        consent: row.consent,
        capsJson: row.capsJson,
        pendingCapsJson: row.pendingCapsJson,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

/**
 * Turns the privacy switch ON or OFF and logs it in auth_events. Turning it ON needs a fresh
 * authenticator code (step-up); turning it OFF never does (it only reduces what is sent).
 */
export function setAiConsent(
  db: Db,
  on: boolean,
  auth: FreshAuth | null,
  now: Date = new Date(),
  meta: ActorMeta = {},
): void {
  if (on) assertFreshAuth(auth, now, 'turning on "Send journal data to the AI"');
  db.transaction((tx) => {
    const view = getAiSettings(tx, now);
    if (view.problem !== null || view.effective === null) {
      // Corrupt settings are never silently rewritten. OFF is always allowed (it only reduces what
      // is sent) and touches nothing else; ON is refused until the settings are readable again.
      if (on) {
        throw new ValidationError([
          {
            field: '',
            message: `The stored analyst settings are corrupt (${view.problem}), so the switch cannot be turned on.`,
          },
        ]);
      }
      tx.update(aiSettings)
        .set({ consent: 0, updatedAt: now.toISOString() })
        .where(eq(aiSettings.id, 1))
        .run();
    } else {
      // `effective` already includes loosenings whose 24 hours passed, so they are kept, not lost.
      writeSettings(tx, { consent: on, caps: view.effective, pending: view.pending }, now);
    }
    appendAuthEvent(tx, {
      kind: on ? 'ai_consent_on' : 'ai_consent_off',
      now,
      sessionId: meta.sessionId ?? (auth ? auth.sessionId : null),
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: view.problem !== null ? 'privacy_switch_settings_corrupt' : 'privacy_switch',
    });
  });
}

/**
 * Submits new caps. Lower values apply now; higher values wait 24 hours AND need a fresh code.
 * Values above a hard ceiling are rejected. Every change is logged in auth_events.
 */
export function updateAiCaps(
  db: Db,
  requested: Record<string, unknown>,
  auth: FreshAuth | null,
  now: Date = new Date(),
  meta: ActorMeta = {},
): CapsChangeResult {
  return db.transaction((tx) => {
    const view = getAiSettings(tx, now);
    if (view.problem !== null || view.active === null) {
      throw new ValidationError([
        {
          field: '',
          message: `The stored analyst settings are corrupt (${view.problem}). They cannot be edited until they are reset.`,
        },
      ]);
    }
    // `effective` = the stored caps plus loosenings whose 24 hours have passed (already authorised),
    // and `pending` = only those still waiting. Both are the base: nothing authorised is lost.
    if (view.effective === null)
      throw new ValidationError([
        { field: '', message: 'The stored analyst settings are corrupt.' },
      ]);
    const result = requestCapsChange(view.effective, view.pending, requested, now);
    if (result.deferred.length > 0) assertFreshAuth(auth, now, 'loosening an analyst spend cap');
    writeSettings(tx, { consent: view.consent, caps: result.active, pending: result.pending }, now);
    const kinds = [
      result.applied.length > 0 ? 'tightened' : null,
      result.deferred.length > 0 ? 'loosening_requested' : null,
      result.cancelled.length > 0 ? 'pending_cancelled' : null,
    ].filter((k): k is string => k !== null);
    if (kinds.length > 0) {
      appendAuthEvent(tx, {
        kind: 'ai_caps_changed',
        now,
        sessionId: meta.sessionId ?? (auth ? auth.sessionId : null),
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: kinds.join('+'),
      });
    }
    return result;
  });
}

// ---- usage ------------------------------------------------------------------------------------

export interface NewUsage {
  at: Date;
  feature: AnalystKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string;
  status: AiUsageStatus;
}

/** Appends one usage row (never a prompt, an answer or a secret). Returns its id. */
export function recordUsage(tx: Writer, u: NewUsage): number {
  return tx
    .insert(aiUsage)
    .values({
      createdAt: u.at.toISOString(),
      feature: u.feature,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      estimatedCostUsd: u.estimatedCostUsd,
      status: u.status,
    })
    .returning({ id: aiUsage.id })
    .get().id;
}

/**
 * Calls and estimated cost so far: today (UTC) and this month (UTC). THROWS AiDataError when the
 * log cannot be read or holds something unreadable: the caller must then refuse (fail closed).
 */
export function getUsageTotals(db: Reader, now: Date = new Date()): UsageTotals {
  let rows: { createdAt: string; cost: string }[];
  try {
    rows = db
      .select({ createdAt: aiUsage.createdAt, cost: aiUsage.estimatedCostUsd })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, utcMonthStart(now).toISOString()))
      .all();
  } catch {
    throw new AiDataError('the usage log could not be read');
  }
  const dayStart = utcDayStart(now).getTime();
  let callsToday = 0;
  let cost = '0';
  for (const r of rows) {
    const at = new Date(r.createdAt).getTime();
    if (Number.isNaN(at)) throw new AiDataError('the usage log holds an unreadable time');
    try {
      cost = addDecimal(cost, r.cost);
    } catch {
      throw new AiDataError('the usage log holds an unreadable cost');
    }
    if (at >= dayStart) callsToday += 1;
  }
  return { callsToday, callsThisMonth: rows.length, costThisMonthUsd: cost };
}

export function listRecentUsage(db: Reader, limit = 20): AiUsageRow[] {
  return db.select().from(aiUsage).orderBy(desc(aiUsage.id)).limit(limit).all();
}

// ---- stored reviews -----------------------------------------------------------------------------

export interface ReviewChecks {
  verified: { label: string; value: string }[];
  unverified: { label: string; value: string }[];
  instructionHits: string[];
  truncated: boolean;
  flagged: boolean;
}

const checksSchema = z.strictObject({
  verified: z.array(z.strictObject({ label: z.string(), value: z.string() })),
  unverified: z.array(z.strictObject({ label: z.string(), value: z.string() })),
  instructionHits: z.array(z.string()),
  truncated: z.boolean(),
  flagged: z.boolean(),
});

export interface NewReview {
  at: Date;
  kind: AnalystKind;
  accountId: number | null;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  currency?: string | null;
  subject: string;
  inputHash: string;
  output: AnalystOutput;
  checks: ReviewChecks;
  usageId: number;
  model: string;
}

export function saveReview(tx: Writer, r: NewReview): number {
  return tx
    .insert(aiReviews)
    .values({
      kind: r.kind,
      accountId: r.accountId,
      rangeFrom: r.rangeFrom ?? null,
      rangeTo: r.rangeTo ?? null,
      currency: r.currency ?? null,
      subject: r.subject,
      inputHash: r.inputHash,
      outputJson: JSON.stringify(r.output),
      checksJson: JSON.stringify(r.checks),
      usageId: r.usageId,
      model: r.model,
      createdAt: r.at.toISOString(),
    })
    .returning({ id: aiReviews.id })
    .get().id;
}

export interface StoredReview {
  id: number;
  kind: AnalystKind;
  accountId: number | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  currency: string | null;
  subject: string;
  model: string;
  createdAt: string;
  /** Null when the stored output no longer passes validation (shown as unreadable, never guessed). */
  output: AnalystOutput | null;
  checks: ReviewChecks | null;
}

function toStored(row: AiReviewRow): StoredReview {
  const parsed = parseStoredOutput(row.kind, row.outputJson);
  let checks: ReviewChecks | null = null;
  try {
    const c = checksSchema.safeParse(JSON.parse(row.checksJson));
    checks = c.success ? c.data : null;
  } catch {
    checks = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.accountId,
    rangeFrom: row.rangeFrom,
    rangeTo: row.rangeTo,
    currency: row.currency,
    subject: row.subject,
    model: row.model,
    createdAt: row.createdAt,
    output: parsed.ok ? parsed.output : null,
    checks,
  };
}

/** Newest first. */
export function listReviews(db: Reader, limit = 50): StoredReview[] {
  return db.select().from(aiReviews).orderBy(desc(aiReviews.id)).limit(limit).all().map(toStored);
}

export function getReview(db: Reader, id: number): StoredReview | null {
  const row = db.select().from(aiReviews).where(eq(aiReviews.id, id)).get();
  return row ? toStored(row) : null;
}

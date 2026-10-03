import { z } from 'zod';
import { ValidationError, type ValidationIssue } from '../errors';
import { compareDecimal, isDecimalString, isPositive, normalizeDecimal } from '../money/decimal';

/**
 * Risk settings: defaults, hard ceilings, and the tighten-now / loosen-after-24h rule.
 *
 * Hard ceilings are in CODE: no setting can exceed them, and anything above them (even if it
 * somehow reached the database) is treated as corrupt and fails closed.
 */

export const RISK_FIELDS = [
  'maxRiskPerTradePercent',
  'maxDailyLossPercent',
  'maxOpenRiskPercent',
  'maxOpenTrades',
  'maxDrawdownPercent',
  'minRewardToRisk',
] as const;
export type RiskField = (typeof RISK_FIELDS)[number];

export interface RiskSettings {
  /** Percent of current equity risked on one trade. */
  maxRiskPerTradePercent: string;
  /** Percent of the equity at the start of the UTC day. */
  maxDailyLossPercent: string;
  /** Percent of current equity: the sum of the risk of all open trades. */
  maxOpenRiskPercent: string;
  maxOpenTrades: number;
  /** Percent fall from peak equity. */
  maxDrawdownPercent: string;
  /** Warning (not a refusal) below this reward-to-risk. */
  minRewardToRisk: string;
}

export const RISK_DEFAULTS: Readonly<RiskSettings> = {
  maxRiskPerTradePercent: '1',
  maxDailyLossPercent: '3',
  maxOpenRiskPercent: '3',
  maxOpenTrades: 3,
  maxDrawdownPercent: '10',
  minRewardToRisk: '1.5',
};

/**
 * Hard ceilings. The first four are the ones you specified. The open-risk ceiling (6 %) and the
 * reward-to-risk sanity limit were added by the engine so no field is unbounded.
 */
export const HARD_CEILINGS = {
  maxRiskPerTradePercent: '2',
  maxDailyLossPercent: '5',
  maxOpenRiskPercent: '6',
  maxOpenTrades: 6,
  maxDrawdownPercent: '20',
  minRewardToRiskMax: '100',
} as const;

export const LOOSEN_DELAY_MS = 24 * 60 * 60 * 1000;

const LABELS: Record<RiskField, string> = {
  maxRiskPerTradePercent: 'Max risk per trade (%)',
  maxDailyLossPercent: 'Max daily loss (%)',
  maxOpenRiskPercent: 'Max total open risk (%)',
  maxOpenTrades: 'Max open trades',
  maxDrawdownPercent: 'Max drawdown (%)',
  minRewardToRisk: 'Minimum reward-to-risk',
};
export const riskFieldLabel = (field: RiskField) => LABELS[field];

const percentField = (field: RiskField, ceiling: string) =>
  z
    .string({ error: `${LABELS[field]} is required` })
    .trim()
    .refine(
      (v) => isDecimalString(v) && isPositive(v),
      `${LABELS[field]} must be a number greater than 0`,
    )
    .refine(
      (v) => !isDecimalString(v) || !isPositive(v) || compareDecimal(v, ceiling) <= 0,
      `${LABELS[field]} cannot be above the hard ceiling of ${ceiling}`,
    )
    .transform((v) => normalizeDecimal(v));

const FIELD_SCHEMAS = {
  maxRiskPerTradePercent: percentField(
    'maxRiskPerTradePercent',
    HARD_CEILINGS.maxRiskPerTradePercent,
  ),
  maxDailyLossPercent: percentField('maxDailyLossPercent', HARD_CEILINGS.maxDailyLossPercent),
  maxOpenRiskPercent: percentField('maxOpenRiskPercent', HARD_CEILINGS.maxOpenRiskPercent),
  maxOpenTrades: z
    .number({ error: `${LABELS.maxOpenTrades} is required and must be a whole number` })
    .int(`${LABELS.maxOpenTrades} must be a whole number`)
    .min(1, `${LABELS.maxOpenTrades} must be at least 1`)
    .max(
      HARD_CEILINGS.maxOpenTrades,
      `${LABELS.maxOpenTrades} cannot be above the hard ceiling of ${HARD_CEILINGS.maxOpenTrades}`,
    ),
  maxDrawdownPercent: percentField('maxDrawdownPercent', HARD_CEILINGS.maxDrawdownPercent),
  minRewardToRisk: z
    .string({ error: `${LABELS.minRewardToRisk} is required` })
    .trim()
    .refine(
      (v) => isDecimalString(v) && isPositive(v),
      `${LABELS.minRewardToRisk} must be a number greater than 0`,
    )
    .refine(
      (v) =>
        !isDecimalString(v) ||
        !isPositive(v) ||
        compareDecimal(v, HARD_CEILINGS.minRewardToRiskMax) <= 0,
      `${LABELS.minRewardToRisk} cannot be above ${HARD_CEILINGS.minRewardToRiskMax}`,
    )
    .transform((v) => normalizeDecimal(v)),
} as const;

const settingsSchema = z.strictObject(FIELD_SCHEMAS);

function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    field: i.path.join('.'),
    message: i.code === 'unrecognized_keys' ? `unknown settings: ${i.keys.join(', ')}` : i.message,
  }));
}

export type ParsedSettings = { ok: true; settings: RiskSettings } | { ok: false; problem: string };

/** Validates stored or submitted settings (all six fields). Never throws. */
export function parseRiskSettings(raw: unknown): ParsedSettings {
  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      problem: issuesOf(result.error)
        .map((i) => `${i.field}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, settings: result.data };
}

/** Parses settings stored as JSON text. A missing, unreadable or invalid value is a problem. */
export function parseSettingsJson(text: string | null | undefined): ParsedSettings {
  if (text === null || text === undefined)
    return { ok: false, problem: 'no risk settings are stored' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the stored risk settings are not readable' };
  }
  return parseRiskSettings(value);
}

// ---- pending (delayed) loosening ------------------------------------------------------------

export interface PendingChange {
  value: string | number;
  requestedAt: string;
  effectiveAt: string;
}
export type PendingMap = Partial<Record<RiskField, PendingChange>>;

export type ParsedPending = { ok: true; pending: PendingMap } | { ok: false; problem: string };

export function parsePendingJson(text: string | null | undefined): ParsedPending {
  if (text === null || text === undefined || text === '') return { ok: true, pending: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the stored pending risk changes are not readable' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'the stored pending risk changes are not valid' };
  }
  const pending: PendingMap = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(RISK_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, problem: `unknown pending setting "${key}"` };
    }
    const field = key as RiskField;
    const e = entry as Partial<PendingChange> | null;
    const valid = FIELD_SCHEMAS[field].safeParse(e?.value);
    if (
      !e ||
      !valid.success ||
      typeof e.requestedAt !== 'string' ||
      typeof e.effectiveAt !== 'string' ||
      Number.isNaN(new Date(e.effectiveAt).getTime())
    ) {
      return { ok: false, problem: `the pending change for ${LABELS[field]} is not valid` };
    }
    (pending as Record<string, PendingChange>)[field] = {
      value: valid.data as string | number,
      requestedAt: e.requestedAt,
      effectiveAt: e.effectiveAt,
    };
  }
  return { ok: true, pending };
}

/** -1 candidate is smaller, 0 equal, 1 larger. */
function compareValues(field: RiskField, a: string | number, b: string | number): -1 | 0 | 1 {
  if (field === 'maxOpenTrades')
    return (a as number) === (b as number) ? 0 : (a as number) < (b as number) ? -1 : 1;
  return compareDecimal(a as string, b as string);
}

/**
 * Is `candidate` tighter (safer) than `current`? Lower is tighter for every limit, except the
 * minimum reward-to-risk where HIGHER is tighter.
 */
export function isTighter(
  field: RiskField,
  candidate: string | number,
  current: string | number,
): boolean {
  const c = compareValues(field, candidate, current);
  return field === 'minRewardToRisk' ? c > 0 : c < 0;
}

export interface SettingsChangeResult {
  active: RiskSettings;
  pending: PendingMap;
  /** Applied immediately (tightened). */
  applied: { field: RiskField; from: string | number; to: string | number }[];
  /** Loosening: waiting for its effective time. */
  deferred: { field: RiskField; value: string | number; effectiveAt: string }[];
  /** A pending change that was cancelled (by a tighter or equal value). */
  cancelled: RiskField[];
  unchanged: RiskField[];
}

/**
 * Handles a settings submission. Tightening applies immediately; loosening is stored as pending
 * and takes effect only LOOSEN_DELAY_MS (24 h) later. Values above a hard ceiling, or invalid,
 * are rejected (all problems listed). Only the fields present in `requested` are considered.
 */
export function requestSettingsChange(
  active: RiskSettings,
  pending: PendingMap,
  requested: Partial<Record<RiskField, unknown>>,
  now: Date,
): SettingsChangeResult {
  const issues: ValidationIssue[] = [];
  const valid: Partial<Record<RiskField, string | number>> = {};
  for (const [key, raw] of Object.entries(requested)) {
    if (!(RISK_FIELDS as readonly string[]).includes(key)) {
      issues.push({ field: key, message: 'is not a risk setting' });
      continue;
    }
    const field = key as RiskField;
    const parsed = FIELD_SCHEMAS[field].safeParse(raw);
    if (parsed.success) valid[field] = parsed.data as string | number;
    else issues.push(...issuesOf(parsed.error).map((i) => ({ field, message: i.message })));
  }
  if (issues.length > 0) throw new ValidationError(issues);

  const nextActive: RiskSettings = { ...active };
  const nextPending: PendingMap = { ...pending };
  const result: SettingsChangeResult = {
    active: nextActive,
    pending: nextPending,
    applied: [],
    deferred: [],
    cancelled: [],
    unchanged: [],
  };

  for (const field of RISK_FIELDS) {
    const value = valid[field];
    if (value === undefined) continue;
    const current = active[field];
    const order = compareValues(field, value, current);
    if (order === 0) {
      if (nextPending[field]) {
        delete nextPending[field];
        result.cancelled.push(field);
      } else {
        result.unchanged.push(field);
      }
    } else if (isTighter(field, value, current)) {
      (nextActive as unknown as Record<string, string | number>)[field] = value;
      if (nextPending[field]) {
        delete nextPending[field];
        result.cancelled.push(field);
      }
      result.applied.push({ field, from: current, to: value });
    } else {
      const existing = nextPending[field];
      if (existing && compareValues(field, existing.value, value) === 0) {
        // Same looser value requested again: keep the original timer (no restart).
        result.deferred.push({ field, value, effectiveAt: existing.effectiveAt });
      } else {
        const effectiveAt = new Date(now.getTime() + LOOSEN_DELAY_MS).toISOString();
        nextPending[field] = { value, requestedAt: now.toISOString(), effectiveAt };
        result.deferred.push({ field, value, effectiveAt });
      }
    }
  }
  return result;
}

/**
 * The settings in force at `now`: the active settings with every pending change whose effective
 * time has arrived (exactly at the effective time counts as arrived). Pure and deterministic, so
 * no background job is needed.
 */
export function settleSettings(
  active: RiskSettings,
  pending: PendingMap,
  now: Date,
): {
  settings: RiskSettings;
  stillPending: PendingMap;
  becameEffective: { field: RiskField; from: string | number; to: string | number }[];
} {
  const settings: RiskSettings = { ...active };
  const stillPending: PendingMap = {};
  const becameEffective: { field: RiskField; from: string | number; to: string | number }[] = [];
  for (const field of RISK_FIELDS) {
    const p = pending[field];
    if (!p) continue;
    if (new Date(p.effectiveAt).getTime() <= now.getTime()) {
      becameEffective.push({ field, from: active[field], to: p.value });
      (settings as unknown as Record<string, string | number>)[field] = p.value;
    } else {
      stillPending[field] = p;
    }
  }
  return { settings, stillPending, becameEffective };
}

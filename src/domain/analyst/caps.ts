import { z } from 'zod';
import { ValidationError, type ValidationIssue } from '../errors';
import {
  addDecimal,
  compareDecimal,
  isDecimalString,
  isPositive,
  normalizeDecimal,
} from '../money/decimal';
import { DAY_MS, nextUtcMidnight } from '../risk/time';

/**
 * Spend caps of the analyst: defaults, hard ceilings, and the same rule as the risk settings:
 * TIGHTENING applies at once, LOOSENING applies 24 hours later (and needs a fresh code, decided
 * by the data layer). The ceilings are in code: nothing, not even a corrupt row, exceeds them.
 */

export const AI_CAP_FIELDS = ['dailyCalls', 'monthlyCalls', 'monthlyCostUsd'] as const;
export type AiCapField = (typeof AI_CAP_FIELDS)[number];

export interface AiCaps {
  dailyCalls: number;
  monthlyCalls: number;
  /** US dollars, decimal text. This is an ESTIMATE cap; the Anthropic console limit is the real one. */
  monthlyCostUsd: string;
}

export const AI_CAP_DEFAULTS: Readonly<AiCaps> = {
  dailyCalls: 20,
  monthlyCalls: 200,
  monthlyCostUsd: '5',
};

export const AI_CAP_CEILINGS: Readonly<AiCaps> = {
  dailyCalls: 100,
  monthlyCalls: 1000,
  monthlyCostUsd: '25',
};

export const AI_LOOSEN_DELAY_MS = DAY_MS;

const LABELS: Record<AiCapField, string> = {
  dailyCalls: 'Calls per day',
  monthlyCalls: 'Calls per month',
  monthlyCostUsd: 'Estimated cost per month (USD)',
};
export const aiCapLabel = (field: AiCapField) => LABELS[field];

const callsField = (field: 'dailyCalls' | 'monthlyCalls') =>
  z
    .number({ error: `${LABELS[field]} must be a whole number` })
    .int(`${LABELS[field]} must be a whole number`)
    .min(1, `${LABELS[field]} must be at least 1`)
    .max(
      AI_CAP_CEILINGS[field],
      `${LABELS[field]} cannot be above the hard ceiling of ${AI_CAP_CEILINGS[field]}`,
    );

const FIELD_SCHEMAS = {
  dailyCalls: callsField('dailyCalls'),
  monthlyCalls: callsField('monthlyCalls'),
  monthlyCostUsd: z
    .string({ error: `${LABELS.monthlyCostUsd} is required` })
    .trim()
    .refine(
      (v) => isDecimalString(v) && isPositive(v),
      `${LABELS.monthlyCostUsd} must be a number greater than 0`,
    )
    .refine(
      (v) =>
        !isDecimalString(v) ||
        !isPositive(v) ||
        compareDecimal(v, AI_CAP_CEILINGS.monthlyCostUsd) <= 0,
      `${LABELS.monthlyCostUsd} cannot be above the hard ceiling of ${AI_CAP_CEILINGS.monthlyCostUsd}`,
    )
    .transform((v) => normalizeDecimal(v)),
} as const;

const capsSchema = z.strictObject(FIELD_SCHEMAS);

export type ParsedCaps = { ok: true; caps: AiCaps } | { ok: false; problem: string };

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/** Validates stored or submitted caps (all three fields). Never throws. */
export function parseCaps(raw: unknown): ParsedCaps {
  const result = capsSchema.safeParse(raw);
  return result.success
    ? { ok: true, caps: result.data }
    : { ok: false, problem: issueText(result.error) };
}

export function parseCapsJson(text: string | null | undefined): ParsedCaps {
  if (text === null || text === undefined) return { ok: false, problem: 'no caps are stored' };
  try {
    return parseCaps(JSON.parse(text));
  } catch {
    return { ok: false, problem: 'the stored caps are not readable' };
  }
}

// ---- pending (delayed) loosening ----------------------------------------------------------------

export interface PendingCap {
  value: string | number;
  requestedAt: string;
  effectiveAt: string;
}
export type PendingCaps = Partial<Record<AiCapField, PendingCap>>;
export type ParsedPendingCaps = { ok: true; pending: PendingCaps } | { ok: false; problem: string };

export function parsePendingCapsJson(text: string | null | undefined): ParsedPendingCaps {
  if (text === null || text === undefined || text === '') return { ok: true, pending: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the stored pending cap changes are not readable' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'the stored pending cap changes are not valid' };
  }
  const pending: PendingCaps = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(AI_CAP_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, problem: `unknown pending cap "${key}"` };
    }
    const field = key as AiCapField;
    const e = entry as Partial<PendingCap> | null;
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
    (pending as Record<string, PendingCap>)[field] = {
      value: valid.data as string | number,
      requestedAt: e.requestedAt,
      effectiveAt: e.effectiveAt,
    };
  }
  return { ok: true, pending };
}

/** -1 smaller, 0 equal, 1 larger. */
function compareValues(field: AiCapField, a: string | number, b: string | number): -1 | 0 | 1 {
  if (field === 'monthlyCostUsd') return compareDecimal(a as string, b as string);
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

/** For every cap a LOWER value is tighter (safer). */
export const isTighterCap = (
  field: AiCapField,
  candidate: string | number,
  current: string | number,
) => compareValues(field, candidate, current) < 0;

export interface CapsChangeResult {
  active: AiCaps;
  pending: PendingCaps;
  applied: { field: AiCapField; from: string | number; to: string | number }[];
  deferred: { field: AiCapField; value: string | number; effectiveAt: string }[];
  cancelled: AiCapField[];
  unchanged: AiCapField[];
}

/**
 * Handles a caps submission. Tightening applies at once; loosening is queued and takes effect
 * AI_LOOSEN_DELAY_MS later. Invalid values or values above a ceiling throw a ValidationError.
 */
export function requestCapsChange(
  active: AiCaps,
  pending: PendingCaps,
  requested: Partial<Record<AiCapField, unknown>>,
  now: Date,
): CapsChangeResult {
  const issues: ValidationIssue[] = [];
  const valid: Partial<Record<AiCapField, string | number>> = {};
  for (const [key, raw] of Object.entries(requested)) {
    if (!(AI_CAP_FIELDS as readonly string[]).includes(key)) {
      issues.push({ field: key, message: 'is not an analyst cap' });
      continue;
    }
    const field = key as AiCapField;
    const parsed = FIELD_SCHEMAS[field].safeParse(raw);
    if (parsed.success) valid[field] = parsed.data as string | number;
    else for (const i of parsed.error.issues) issues.push({ field, message: i.message });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  const nextActive: AiCaps = { ...active };
  const nextPending: PendingCaps = { ...pending };
  const result: CapsChangeResult = {
    active: nextActive,
    pending: nextPending,
    applied: [],
    deferred: [],
    cancelled: [],
    unchanged: [],
  };
  for (const field of AI_CAP_FIELDS) {
    const value = valid[field];
    if (value === undefined) continue;
    const current = active[field];
    const order = compareValues(field, value, current);
    if (order === 0) {
      if (nextPending[field]) {
        delete nextPending[field];
        result.cancelled.push(field);
      } else result.unchanged.push(field);
    } else if (isTighterCap(field, value, current)) {
      (nextActive as unknown as Record<string, string | number>)[field] = value;
      if (nextPending[field]) {
        delete nextPending[field];
        result.cancelled.push(field);
      }
      result.applied.push({ field, from: current, to: value });
    } else {
      const existing = nextPending[field];
      if (existing && compareValues(field, existing.value, value) === 0) {
        result.deferred.push({ field, value, effectiveAt: existing.effectiveAt });
      } else {
        const effectiveAt = new Date(now.getTime() + AI_LOOSEN_DELAY_MS).toISOString();
        nextPending[field] = { value, requestedAt: now.toISOString(), effectiveAt };
        result.deferred.push({ field, value, effectiveAt });
      }
    }
  }
  return result;
}

/** The caps in force at `now`: active caps plus every pending change that is already due. */
export function settleCaps(
  active: AiCaps,
  pending: PendingCaps,
  now: Date,
): {
  caps: AiCaps;
  stillPending: PendingCaps;
  becameEffective: { field: AiCapField; from: string | number; to: string | number }[];
} {
  const caps: AiCaps = { ...active };
  const stillPending: PendingCaps = {};
  const becameEffective: { field: AiCapField; from: string | number; to: string | number }[] = [];
  for (const field of AI_CAP_FIELDS) {
    const p = pending[field];
    if (!p) continue;
    if (new Date(p.effectiveAt).getTime() <= now.getTime()) {
      becameEffective.push({ field, from: active[field], to: p.value });
      (caps as unknown as Record<string, string | number>)[field] = p.value;
    } else stillPending[field] = p;
  }
  return { caps, stillPending, becameEffective };
}

// ---- the check before a request ----------------------------------------------------------------

export interface UsageTotals {
  callsToday: number;
  callsThisMonth: number;
  /** Estimated cost so far this UTC month, USD decimal text. */
  costThisMonthUsd: string;
}

export type CapCheck =
  | { allowed: true }
  | {
      allowed: false;
      code: 'DAILY_CALLS' | 'MONTHLY_CALLS' | 'MONTHLY_COST';
      message: string;
      /** When the period resets (UTC). */
      resetsAt: string;
    };

/** First instant of the next UTC month. */
export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
export const utcMonthStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * May one more request be sent? `projectedCostUsd` is the WORST case for that request, so the
 * monthly cost cap cannot be passed by the request itself. Fails closed on unparseable totals.
 */
export function checkCaps(
  caps: AiCaps,
  usage: UsageTotals,
  projectedCostUsd: string,
  now: Date,
): CapCheck {
  const dayReset = nextUtcMidnight(now).toISOString();
  const monthReset = nextUtcMonthStart(now).toISOString();
  if (
    !Number.isInteger(usage.callsToday) ||
    !Number.isInteger(usage.callsThisMonth) ||
    usage.callsToday < 0 ||
    usage.callsThisMonth < 0 ||
    !isDecimalString(usage.costThisMonthUsd) ||
    !isDecimalString(projectedCostUsd)
  ) {
    return {
      allowed: false,
      code: 'MONTHLY_COST',
      message: 'The usage figures could not be read, so no request is sent.',
      resetsAt: monthReset,
    };
  }
  if (usage.callsToday >= caps.dailyCalls) {
    return {
      allowed: false,
      code: 'DAILY_CALLS',
      message: `The daily limit of ${caps.dailyCalls} analyst calls is reached. It resets at the next UTC midnight.`,
      resetsAt: dayReset,
    };
  }
  if (usage.callsThisMonth >= caps.monthlyCalls) {
    return {
      allowed: false,
      code: 'MONTHLY_CALLS',
      message: `The monthly limit of ${caps.monthlyCalls} analyst calls is reached. It resets on the 1st (UTC).`,
      resetsAt: monthReset,
    };
  }
  const afterCall = addDecimal(usage.costThisMonthUsd, projectedCostUsd);
  if (compareDecimal(afterCall, caps.monthlyCostUsd) > 0) {
    return {
      allowed: false,
      code: 'MONTHLY_COST',
      message: `This request could take the estimated monthly cost (${usage.costThisMonthUsd} USD so far) above your cap of ${caps.monthlyCostUsd} USD, so it is not sent. It resets on the 1st (UTC).`,
      resetsAt: monthReset,
    };
  }
  return { allowed: true };
}

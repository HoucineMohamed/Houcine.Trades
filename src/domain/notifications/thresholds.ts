import { z } from 'zod';
import { Dec } from '../money/decimal';
import { isDecimalString, compareDecimal } from '../money/decimal';
import { USAGE_LEVELS, type UsageLevel } from './kinds';

/**
 * When is a usage level (50, 80, 100 percent of a limit) announced? Once per period, and again
 * only after usage has fallen below that level and risen again, never twice within an hour.
 * Pure: the caller keeps the small state between looks.
 */

export type Level = 0 | UsageLevel;
export const COOLDOWN_MS = 60 * 60 * 1000;

export const utcDayKey = (now: Date): string => now.toISOString().slice(0, 10);
export const utcMonthKey = (now: Date): string => now.toISOString().slice(0, 7);

/**
 * The level reached, from the engine's own figures. Only `reached === true` (the engine's exact
 * comparison) gives 100: a rounded-up share of 100 that is not confirmed as reached counts as 80. `null` means "cannot be verified": nothing is
 * announced and the state is left alone (fail closed: never guessed).
 */
export function levelFromShare(share: string | null, reached: boolean | null): Level | null {
  if (reached === true) return 100;
  if (share === null || !isDecimalString(share)) return null; // cannot be read: unknown, never "fine"
  if (compareDecimal(share, '80') >= 0) return 80;
  if (compareDecimal(share, '50') >= 0) return 50;
  return 0;
}

/** The level of a usage figure against a cap (used and cap are exact numbers as text). */
export function levelFromCap(used: string | number, cap: string | number): Level | null {
  const u = String(used);
  const c = String(cap);
  if (!isDecimalString(u) || !isDecimalString(c)) return null;
  const usedD = new Dec(u);
  const capD = new Dec(c);
  if (capD.lte(0)) return null;
  if (usedD.gte(capD)) return 100;
  let level: Level = 0;
  for (const l of USAGE_LEVELS) if (usedD.times(100).gte(capD.times(l))) level = l;
  return level;
}

export interface LimitState {
  periodKey: string;
  level: Level;
  /** Counts how many times usage fell below an announced level: part of the dedupe key. */
  epoch: number;
  /** When each level was last announced (ISO), for the one-hour cooldown. */
  lastAnnounced: Record<string, string>;
}

const stateSchema = z.strictObject({
  periodKey: z.string(),
  level: z.union([z.literal(0), z.literal(50), z.literal(80), z.literal(100)]),
  epoch: z.number().int().nonnegative(),
  lastAnnounced: z.record(z.string(), z.string()),
});

export function parseLimitState(text: string | null | undefined): LimitState | null {
  if (!text) return null;
  try {
    const r = stateSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export const baselineLimitState = (observed: Level | null, periodKey: string): LimitState => ({
  periodKey,
  level: observed ?? 0,
  epoch: 0,
  lastAnnounced: {},
});

export interface Announcement {
  level: UsageLevel;
  dedupeKey: string;
}

export function stepLimit(
  previous: LimitState | null,
  observed: Level | null,
  periodKey: string,
  base: string,
  now: Date,
): { state: LimitState; announce: Announcement | null } {
  let state: LimitState =
    previous && previous.periodKey === periodKey
      ? { ...previous, lastAnnounced: { ...previous.lastAnnounced } }
      : { periodKey, level: 0, epoch: 0, lastAnnounced: {} };
  if (observed === null) return { state, announce: null };
  if (observed < state.level) {
    state = { ...state, level: observed, epoch: state.epoch + 1 };
    return { state, announce: null };
  }
  if (observed === state.level || observed === 0) return { state, announce: null };
  const level = observed as UsageLevel;
  const last = state.lastAnnounced[String(level)];
  const cooling = last !== undefined && now.getTime() - Date.parse(last) < COOLDOWN_MS;
  const next: LimitState = { ...state, level: observed };
  if (cooling) return { state: next, announce: null };
  next.lastAnnounced[String(level)] = now.toISOString();
  return {
    state: next,
    announce: { level, dedupeKey: `${base}:${periodKey}:${state.epoch}:${level}` },
  };
}

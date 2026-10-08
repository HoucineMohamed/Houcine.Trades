/**
 * When a child process (web server or worker) crashes: restart it, wait longer each time, and give
 * up when it keeps crashing so the platform restarts the whole container instead. Pure.
 */

export interface CrashPolicy {
  /** Crashes inside this window count toward giving up. */
  windowMs: number;
  /** This many crashes inside the window means give up. */
  maxCrashes: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const CRASH_POLICY: CrashPolicy = {
  windowMs: 5 * 60_000,
  maxCrashes: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export type CrashDecision = { action: 'restart'; delayMs: number } | { action: 'give_up' };

/**
 * `crashTimes` are the times (ms) of earlier crashes of THIS child, `now` is the crash just seen.
 * Returns the decision and the crash list to keep.
 */
export function decideAfterCrash(
  crashTimes: readonly number[],
  now: number,
  policy: CrashPolicy = CRASH_POLICY,
): { decision: CrashDecision; crashTimes: number[] } {
  const recent = [...crashTimes, now].filter((t) => now - t < policy.windowMs);
  if (recent.length >= policy.maxCrashes)
    return { decision: { action: 'give_up' }, crashTimes: recent };
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (recent.length - 1));
  return { decision: { action: 'restart', delayMs }, crashTimes: recent };
}

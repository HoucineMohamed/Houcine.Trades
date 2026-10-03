/**
 * Progressive delays for failed login and code attempts. NEVER a permanent lockout.
 *
 * After `freeFailures` failures inside the window, each further failure makes the next attempt
 * wait longer (doubling), up to `capMs`. The wait is counted from the last PROCESSED failure.
 * Attempts made while waiting are rejected without being checked and are NOT counted, so an
 * attacker hammering the door cannot push the wait further out and lock the owner out.
 */

export interface ThrottleConfig {
  /** Failures allowed (inside the window) before any delay applies. */
  freeFailures: number;
  /** Delay after the first failure beyond the free ones; doubles after each further failure. */
  baseDelayMs: number;
  /** The delay never grows beyond this. */
  capMs: number;
  /** Only failures newer than this are counted. */
  windowMs: number;
}

/** Per source (see docs/security.md about what "source" means before a trusted proxy exists). */
export const SOURCE_THROTTLE: Readonly<ThrottleConfig> = {
  freeFailures: 4, // the 5th failure starts the delays: 5 s, 10 s, 20 s, ... up to 15 minutes
  baseDelayMs: 5_000,
  capMs: 15 * 60_000,
  windowMs: 60 * 60_000,
};

/** All sources together (protects against attackers that use many sources). */
export const GLOBAL_THROTTLE: Readonly<ThrottleConfig> = {
  freeFailures: 20,
  baseDelayMs: 5_000,
  capMs: 5 * 60_000,
  windowMs: 60 * 60_000,
};

/** The wait that follows the `failures`-th failure (0 while still inside the free ones). */
export function delayAfterFailures(failures: number, config: ThrottleConfig): number {
  if (!Number.isInteger(failures) || failures <= config.freeFailures) return 0;
  const exponent = failures - config.freeFailures - 1;
  // 2 ** 40 is already far above any cap; avoids overflow for absurd inputs
  const delay = config.baseDelayMs * 2 ** Math.min(exponent, 40);
  return Math.min(delay, config.capMs);
}

export interface ThrottleState {
  blocked: boolean;
  /** Milliseconds until the next attempt will be processed (0 when not blocked). */
  retryAfterMs: number;
}

/**
 * @param failureTimes epoch milliseconds of processed failures (any order, any age)
 */
export function evaluateThrottle(
  failureTimes: readonly number[],
  now: number,
  config: ThrottleConfig,
): ThrottleState {
  const recent = failureTimes.filter((t) => t > now - config.windowMs && t <= now);
  if (recent.length === 0) return { blocked: false, retryAfterMs: 0 };
  const last = Math.max(...recent);
  const until = last + delayAfterFailures(recent.length, config);
  const retryAfterMs = Math.max(0, until - now);
  return { blocked: retryAfterMs > 0, retryAfterMs };
}

/** The longer of two waits (source and global). */
export function combineThrottles(a: ThrottleState, b: ThrottleState): ThrottleState {
  const retryAfterMs = Math.max(a.retryAfterMs, b.retryAfterMs);
  return { blocked: retryAfterMs > 0, retryAfterMs };
}

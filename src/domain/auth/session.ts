/** Session lifetime rules. Pure: the caller passes the clock. */

export interface SessionTimes {
  /** Idle timeout: a session unused for this long ends. */
  idleMs: number;
  /** Absolute lifetime: a session ends this long after login, however busy. */
  absoluteMs: number;
}

export type SessionExpiry =
  { valid: true } | { valid: false; reason: 'idle' | 'absolute' | 'invalid' };

/**
 * A session is valid only BEFORE its expiry (exactly at the expiry moment it is already over).
 * Anything unreadable is invalid (fail closed).
 */
export function checkSessionTimes(
  createdAt: string,
  lastSeenAt: string,
  now: Date,
  times: SessionTimes,
): SessionExpiry {
  const created = new Date(createdAt).getTime();
  const seen = new Date(lastSeenAt).getTime();
  const t = now.getTime();
  if (Number.isNaN(created) || Number.isNaN(seen) || Number.isNaN(t)) {
    return { valid: false, reason: 'invalid' };
  }
  if (t >= created + times.absoluteMs) return { valid: false, reason: 'absolute' };
  if (t >= seen + times.idleMs) return { valid: false, reason: 'idle' };
  return { valid: true };
}

/** last_seen is saved at most this often, to avoid a database write on every request. */
export const TOUCH_INTERVAL_MS = 60_000;

export function shouldTouch(lastSeenAt: string, now: Date): boolean {
  const seen = new Date(lastSeenAt).getTime();
  return Number.isNaN(seen) || now.getTime() - seen >= TOUCH_INTERVAL_MS;
}

export const SESSION_BOUNDS = {
  idleMinutes: { min: 5, max: 480, default: 120 },
  absoluteHours: { min: 1, max: 72, default: 12 },
} as const;

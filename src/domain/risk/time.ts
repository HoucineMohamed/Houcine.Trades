/** UTC day helpers. The risk day boundary is always UTC midnight (documented in risk-rules.md). */

export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + DAY_MS);
}

/** True when `iso` falls inside the UTC day that starts at `dayStart`. Invalid text is false. */
export function isInUtcDay(iso: string | null | undefined, dayStart: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= dayStart.getTime() && t < dayStart.getTime() + DAY_MS;
}

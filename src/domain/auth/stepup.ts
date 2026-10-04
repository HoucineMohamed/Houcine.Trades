/**
 * Step-up ("fresh code") proof.
 *
 * Sensitive actions need an authenticator code entered within the last 5 minutes. This module is
 * the ONE mechanism for that, so later modules cannot forget it:
 *
 * - `FreshAuth` is a proof value. Only the auth code (src/auth) can issue it, after it has really
 *   checked a code. It cannot be forged: it is tracked in a private WeakSet, so a hand-made object
 *   with the same shape is rejected at runtime, and the type brand stops it at compile time.
 * - Sensitive data functions take a `FreshAuth` and call `assertFreshAuth`, which also refuses a
 *   proof that is older than the window.
 *
 * Anything that could place a real order (module 9) MUST take a FreshAuth the same way.
 */

export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

declare const freshAuthBrand: unique symbol;

export interface FreshAuth {
  readonly [freshAuthBrand]: true;
  readonly sessionId: number;
  /** When the code was verified (ISO). */
  readonly verifiedAt: string;
}

const issued = new WeakSet<object>();

/** Only src/auth (after verifying a code) and the test helpers may call this (ESLint enforces it). */
export function issueFreshAuth(sessionId: number, verifiedAt: Date): FreshAuth {
  const proof = Object.freeze({
    sessionId,
    verifiedAt: verifiedAt.toISOString(),
  }) as unknown as FreshAuth;
  issued.add(proof);
  return proof;
}

export class StepUpRequiredError extends Error {
  constructor(readonly reason: string) {
    super(`A fresh authenticator code is required: ${reason}`);
    this.name = 'StepUpRequiredError';
  }
}

/** Is a step-up done at `stepUpAt` still fresh at `now`? (Strictly inside the 5 minutes.) */
export function isStepUpFresh(stepUpAt: string | null | undefined, now: Date): boolean {
  if (!stepUpAt) return false;
  const at = new Date(stepUpAt).getTime();
  if (Number.isNaN(at)) return false;
  const elapsed = now.getTime() - at;
  return elapsed >= 0 && elapsed < STEP_UP_WINDOW_MS;
}

/**
 * Throws StepUpRequiredError unless `auth` is a genuine proof issued by the auth code and still
 * fresh. Returns it so callers can pass it on.
 */
export function assertFreshAuth(
  auth: FreshAuth | null | undefined,
  now: Date,
  reason: string,
): FreshAuth {
  if (
    !auth ||
    typeof auth !== 'object' ||
    !issued.has(auth) ||
    !isStepUpFresh(auth.verifiedAt, now)
  ) {
    throw new StepUpRequiredError(reason);
  }
  return auth;
}

/** Kept with no imports so the database schema (loaded by drizzle-kit) can use it. */
export const AUTH_EVENT_KINDS = [
  'owner_created',
  'owner_reset',
  'login_success',
  'login_failure',
  'recovery_used',
  'step_up_success',
  'step_up_failure',
  'logout',
  'logout_all',
  'session_revoked',
  'password_changed',
  'recovery_regenerated',
  'rate_limit_tripped',
  // Analyst module: the privacy switch and the spend caps (detail is a short generic code).
  'ai_consent_on',
  'ai_consent_off',
  'ai_caps_changed',
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

export const ATTEMPT_KINDS = ['login', 'step_up'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

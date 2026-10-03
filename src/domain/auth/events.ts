/**
 * Authentication events (the append-only auth_events log). Failures are logged GENERICALLY: which
 * factor failed is never recorded. Passwords, codes, tokens and secrets are never logged.
 */
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
] as const;
export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

/** Generic failure reasons (what the owner may see on /security). */
export const FAILURE_REASONS = ['invalid_credentials', 'throttled', 'secret_unavailable'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

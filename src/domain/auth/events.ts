/**
 * Authentication events (the append-only auth_events log). Failures are logged GENERICALLY: which
 * factor failed is never recorded. Passwords, codes, tokens and secrets are never logged.
 */
export { AUTH_EVENT_KINDS, ATTEMPT_KINDS } from './kinds';
export type { AuthEventKind, AttemptKind } from './kinds';

/** Generic failure reasons (what the owner may see on /security). */
export const FAILURE_REASONS = ['invalid_credentials', 'throttled', 'secret_unavailable'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

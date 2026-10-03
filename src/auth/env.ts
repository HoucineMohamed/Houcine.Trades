import 'server-only';
import { z } from 'zod';
import { SESSION_BOUNDS, type SessionTimes } from '@/domain/auth/session';

/**
 * Settings for the auth module, validated with zod and read lazily. Builds, tests and the db:*
 * commands never need AUTH_SECRET; any attempt to actually log in without a valid one fails
 * closed with a clear message (and never prints the value).
 */

export const AUTH_SECRET_MIN_LENGTH = 32;
const PLACEHOLDER =
  /replace|change.?me|placeholder|example|your[-_ ]|insert|todo|secret.?here|xxxx/i;

/** How many different characters the secret must contain (a crude guard against "aaaa...", "1234..."). */
const MIN_DISTINCT_CHARS = 12;

const integerFromText = (label: string, min: number, max: number, fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? String(fallback) : v))
    .pipe(
      z
        .string()
        .regex(/^\d+$/, `${label} must be a whole number`)
        .transform(Number)
        .pipe(
          z
            .number()
            .min(min, `${label} must be at least ${min}`)
            .max(max, `${label} must be at most ${max}`),
        ),
    );

const authEnvSchema = z.object({
  AUTH_SECRET: z
    .string({ error: 'AUTH_SECRET is missing' })
    .min(
      AUTH_SECRET_MIN_LENGTH,
      `AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters`,
    )
    .refine(
      (v) => !PLACEHOLDER.test(v),
      'AUTH_SECRET still looks like the placeholder from .env.example',
    )
    .refine((v) => new Set(v).size >= MIN_DISTINCT_CHARS, 'AUTH_SECRET is not random enough'),
  SESSION_IDLE_MINUTES: integerFromText(
    'SESSION_IDLE_MINUTES',
    SESSION_BOUNDS.idleMinutes.min,
    SESSION_BOUNDS.idleMinutes.max,
    SESSION_BOUNDS.idleMinutes.default,
  ),
  SESSION_ABSOLUTE_HOURS: integerFromText(
    'SESSION_ABSOLUTE_HOURS',
    SESSION_BOUNDS.absoluteHours.min,
    SESSION_BOUNDS.absoluteHours.max,
    SESSION_BOUNDS.absoluteHours.default,
  ),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v ?? 'false').trim().toLowerCase())
    .pipe(z.enum(['true', 'false'], { error: 'TRUST_PROXY must be "true" or "false"' }))
    .transform((v) => v === 'true'),
});

export interface AuthEnv {
  secret: string;
  session: SessionTimes;
  /** True only behind a reverse proxy YOU control (module 8): then X-Forwarded-* headers are believed. */
  trustProxy: boolean;
}

export class AuthEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthEnvError';
  }
}

/** Never echoes any value: only which setting is wrong and why. */
export function parseAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const result = authEnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AuthEnvError(`Invalid authentication settings (see docs/security.md) - ${details}`);
  }
  const v = result.data;
  const session = {
    idleMs: v.SESSION_IDLE_MINUTES * 60_000,
    absoluteMs: v.SESSION_ABSOLUTE_HOURS * 3_600_000,
  };
  if (session.idleMs > session.absoluteMs) {
    throw new AuthEnvError(
      'Invalid authentication settings - SESSION_IDLE_MINUTES cannot be longer than SESSION_ABSOLUTE_HOURS',
    );
  }
  return { secret: v.AUTH_SECRET, session, trustProxy: v.TRUST_PROXY };
}

let cached: AuthEnv | undefined;
export function getAuthEnv(): AuthEnv {
  cached ??= parseAuthEnv(process.env);
  return cached;
}

/** Tests only: forget the cached settings. */
export function resetAuthEnvCache(): void {
  cached = undefined;
}

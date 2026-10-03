import 'server-only';
import type { Db, Reader } from '@/data/client';
import {
  appendAuthEvent,
  claimTotpStep,
  clearBucket,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  failureTimes,
  findSessionByTokenHash,
  getOwner,
  insertOwner,
  insertSession,
  listAuthEvents,
  listSessions,
  markStepUp,
  pruneAttempts,
  recordFailedAttempt,
  replaceRecoveryCodes,
  revokeAllSessions,
  revokeSession,
  touchSession,
  updateOwnerPassword,
  updateOwnerTotp,
} from '@/data/auth';
import { checkPassword } from '@/domain/auth/policy';
import { formatRecoveryCode, normalizeTotpCode } from '@/domain/auth/recovery';
import { checkSessionTimes, shouldTouch } from '@/domain/auth/session';
import {
  assertFreshAuth,
  isStepUpFresh,
  issueFreshAuth,
  type FreshAuth,
} from '@/domain/auth/stepup';
import {
  combineThrottles,
  evaluateThrottle,
  GLOBAL_THROTTLE,
  SOURCE_THROTTLE,
  type ThrottleState,
} from '@/domain/auth/throttle';
import { GLOBAL_BUCKET, sourceBucket, type ClientInfo } from './client';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCodeInput,
  hashSessionToken,
  randomToken,
  sha256Hex,
  verifyAgainstDummy,
  verifyPassword,
} from './crypto';
import { AuthEnvError, getAuthEnv, type AuthEnv } from './env';
import { generateTotpSecret, totpUri, verifyTotp } from './totp';

/**
 * Authentication services: login, sessions, step-up, password and recovery management, and the
 * owner set-up used by the command-line scripts. There is NO web sign-up or reset.
 *
 * Principles: one generic error for every credential failure, equal work whatever fails (a dummy
 * password hash when there is no owner), constant-time comparisons, progressive delays that can
 * never become a permanent lockout, and nothing secret ever logged.
 */

export interface AuthOptions {
  now?: Date;
  /** Tests pass their own settings; the app reads them from the environment. */
  env?: AuthEnv;
}

const nowOf = (o: AuthOptions) => o.now ?? new Date();

const MAX_PASSWORD_INPUT = 1024;
const MAX_CODE_INPUT = 64;

// ---- rate limiting ---------------------------------------------------------------------------------

export function currentThrottle(db: Reader, client: ClientInfo, now: Date): ThrottleState {
  const t = now.getTime();
  const source = evaluateThrottle(
    failureTimes(db, sourceBucket(client), t - SOURCE_THROTTLE.windowMs),
    t,
    SOURCE_THROTTLE,
  );
  const global = evaluateThrottle(
    failureTimes(db, GLOBAL_BUCKET, t - GLOBAL_THROTTLE.windowMs),
    t,
    GLOBAL_THROTTLE,
  );
  return combineThrottles(source, global);
}

/** Records a PROCESSED failure (never called for attempts rejected during a delay). */
function recordFailure(
  tx: Parameters<typeof recordFailedAttempt>[0],
  db: Reader,
  client: ClientInfo,
  kind: 'login' | 'step_up',
  now: Date,
  sessionId: number | null,
): void {
  recordFailedAttempt(tx, [GLOBAL_BUCKET, sourceBucket(client)], kind, now.getTime());
  pruneAttempts(tx, now.getTime() - 24 * 3_600_000);
  appendAuthEvent(tx, {
    kind: kind === 'login' ? 'login_failure' : 'step_up_failure',
    now,
    sessionId,
    ip: client.ip,
    userAgent: client.userAgent,
    detail: 'invalid_credentials', // generic: never says WHICH factor failed
  });
  if (currentThrottle(db, client, now).blocked) {
    appendAuthEvent(tx, {
      kind: 'rate_limit_tripped',
      now,
      sessionId,
      ip: client.ip,
      userAgent: client.userAgent,
      detail: 'delay_started',
    });
  }
}

// ---- login -------------------------------------------------------------------------------------------

export type LoginResult =
  | {
      ok: true;
      token: string;
      sessionId: number;
      usedRecoveryCode: boolean;
      recoveryCodesLeft: number;
    }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'throttled'; retryAfterMs: number }
  | { ok: false; reason: 'not_configured' };

/**
 * Password + authenticator code (or a recovery code) in ONE step, so nothing reveals which part
 * was wrong. Every attempt does the same work.
 */
export async function login(
  db: Db,
  input: { password: unknown; code: unknown },
  client: ClientInfo,
  options: AuthOptions = {},
): Promise<LoginResult> {
  const now = nowOf(options);
  let env: AuthEnv;
  try {
    env = options.env ?? getAuthEnv();
  } catch (error) {
    if (error instanceof AuthEnvError) return { ok: false, reason: 'not_configured' };
    throw error;
  }

  // 1. A delay is in force: reject WITHOUT checking anything and WITHOUT counting this attempt.
  const throttle = currentThrottle(db, client, now);
  if (throttle.blocked)
    return { ok: false, reason: 'throttled', retryAfterMs: throttle.retryAfterMs };

  const password =
    typeof input.password === 'string' && input.password.length <= MAX_PASSWORD_INPUT
      ? input.password
      : null;
  const codeText =
    typeof input.code === 'string' && input.code.length <= MAX_CODE_INPUT ? input.code : '';
  const owner = getOwner(db);

  // 2. The same work every time: a real or dummy password check, then both kinds of code check.
  const passwordOk =
    password !== null && owner
      ? await verifyPassword(owner.passwordHash, password)
      : (await verifyAgainstDummy(password ?? ''), false);

  let totpStep: number | null = null;
  let recoveryHash: string | null = null;
  if (owner) {
    if (normalizeTotpCode(codeText) !== null) {
      try {
        const secret = decryptTotpSecret(owner.totpSecretEnc, env.secret);
        const r = verifyTotp({
          secretBase32: secret,
          code: codeText,
          now,
          lastUsedStep: owner.totpLastStep,
        });
        if (r.ok) totpStep = r.step;
      } catch {
        // secret cannot be read (AUTH_SECRET changed): the code simply does not verify
      }
    } else {
      recoveryHash = hashRecoveryCodeInput(codeText);
    }
  }

  const token = randomToken();

  // 3. All state changes in one transaction. The replay check and the "use a recovery code once"
  //    check are atomic updates, so two simultaneous requests cannot both succeed.
  type Outcome =
    { ok: true; sessionId: number; usedRecoveryCode: boolean; left: number } | { ok: false };
  const outcome = db.transaction((tx): Outcome => {
    if (passwordOk && owner && (totpStep !== null || recoveryHash !== null)) {
      const accepted =
        totpStep !== null
          ? claimTotpStep(tx, totpStep)
          : consumeRecoveryCode(tx, recoveryHash as string, now);
      if (accepted) {
        const usedRecovery = totpStep === null;
        if (usedRecovery) revokeAllSessions(tx, 'recovery_used', now); // recovery = break-glass: end every other session
        const session = insertSession(tx, {
          tokenHash: hashSessionToken(token),
          now,
          ip: client.ip,
          userAgent: client.userAgent,
          stepUpAt: usedRecovery ? null : now, // the login code counts as a fresh step-up
        });
        clearBucket(tx, sourceBucket(client));
        appendAuthEvent(tx, {
          kind: 'login_success',
          now,
          sessionId: session.id,
          ip: client.ip,
          userAgent: client.userAgent,
        });
        if (usedRecovery) {
          appendAuthEvent(tx, {
            kind: 'recovery_used',
            now,
            sessionId: session.id,
            ip: client.ip,
            userAgent: client.userAgent,
          });
        }
        return {
          ok: true,
          sessionId: session.id,
          usedRecoveryCode: usedRecovery,
          left: countUnusedRecoveryCodes(tx),
        };
      }
    }
    recordFailure(tx, db, client, 'login', now, null);
    return { ok: false };
  });

  if (!outcome.ok) return { ok: false, reason: 'invalid_credentials' };
  return {
    ok: true,
    token,
    sessionId: outcome.sessionId,
    usedRecoveryCode: outcome.usedRecoveryCode,
    recoveryCodesLeft: outcome.left,
  };
}

// ---- sessions ------------------------------------------------------------------------------------------

export interface SessionInfo {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  stepUpAt: string | null;
  ip: string;
  userAgent: string;
}

/**
 * Looks the session up by the HASH of the cookie token. Returns null for anything wrong: unknown,
 * tampered, revoked, idle too long, too old. Expired sessions are revoked on the spot.
 */
export function verifySession(
  db: Db,
  token: unknown,
  options: AuthOptions = {},
): SessionInfo | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const now = nowOf(options);
  const env = options.env ?? getAuthEnv();
  const row = findSessionByTokenHash(db, hashSessionToken(token));
  if (!row || row.revokedAt !== null) return null;
  const check = checkSessionTimes(row.createdAt, row.lastSeenAt, now, env.session);
  if (!check.valid) {
    db.transaction((tx) => {
      if (revokeSession(tx, row.id, `expired_${check.reason}`, now)) {
        appendAuthEvent(tx, {
          kind: 'session_revoked',
          now,
          sessionId: row.id,
          detail: `expired_${check.reason}`,
        });
      }
    });
    return null;
  }
  let lastSeenAt = row.lastSeenAt;
  if (shouldTouch(row.lastSeenAt, now)) {
    touchSession(db, row.id, now);
    lastSeenAt = now.toISOString();
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    lastSeenAt,
    stepUpAt: row.stepUpAt,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}

export function logout(
  db: Db,
  session: SessionInfo,
  client: ClientInfo,
  options: AuthOptions = {},
): void {
  const now = nowOf(options);
  db.transaction((tx) => {
    revokeSession(tx, session.id, 'logout', now);
    appendAuthEvent(tx, {
      kind: 'logout',
      now,
      sessionId: session.id,
      ip: client.ip,
      userAgent: client.userAgent,
    });
  });
}

// ---- step-up (fresh code) --------------------------------------------------------------------------------

/** The proof for this session if a code was entered in the last 5 minutes, else null. */
export function freshAuthFor(session: SessionInfo, now: Date): FreshAuth | null {
  if (!isStepUpFresh(session.stepUpAt, now)) return null;
  return issueFreshAuth(session.id, new Date(session.stepUpAt as string));
}

export type StepUpResult =
  | { ok: true; auth: FreshAuth }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'throttled'; retryAfterMs: number }
  | { ok: false; reason: 'not_configured' };

/** Checks a fresh authenticator code for an already logged-in session (recovery codes are not accepted here). */
export function stepUp(
  db: Db,
  session: SessionInfo,
  codeInput: unknown,
  client: ClientInfo,
  options: AuthOptions = {},
): StepUpResult {
  const now = nowOf(options);
  let env: AuthEnv;
  try {
    env = options.env ?? getAuthEnv();
  } catch (error) {
    if (error instanceof AuthEnvError) return { ok: false, reason: 'not_configured' };
    throw error;
  }
  const throttle = currentThrottle(db, client, now);
  if (throttle.blocked)
    return { ok: false, reason: 'throttled', retryAfterMs: throttle.retryAfterMs };

  const owner = getOwner(db);
  const code = typeof codeInput === 'string' && codeInput.length <= MAX_CODE_INPUT ? codeInput : '';
  let step: number | null = null;
  if (owner) {
    try {
      const secret = decryptTotpSecret(owner.totpSecretEnc, env.secret);
      const r = verifyTotp({ secretBase32: secret, code, now, lastUsedStep: owner.totpLastStep });
      if (r.ok) step = r.step;
    } catch {
      // unreadable secret: does not verify
    }
  }

  const ok = db.transaction((tx) => {
    if (step !== null && claimTotpStep(tx, step)) {
      markStepUp(tx, session.id, now);
      appendAuthEvent(tx, {
        kind: 'step_up_success',
        now,
        sessionId: session.id,
        ip: client.ip,
        userAgent: client.userAgent,
      });
      return true;
    }
    recordFailure(tx, db, client, 'step_up', now, session.id);
    return false;
  });
  return ok
    ? { ok: true, auth: issueFreshAuth(session.id, now) }
    : { ok: false, reason: 'invalid_credentials' };
}

// ---- security settings (each needs a fresh code) ------------------------------------------------------------

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'throttled'; retryAfterMs: number }
  | { ok: false; reason: 'weak_password'; problems: string[] };

/** Needs a fresh code AND the current password. Ends every OTHER session. */
export async function changePassword(
  db: Db,
  session: SessionInfo,
  input: { currentPassword: unknown; newPassword: unknown },
  auth: FreshAuth | null | undefined,
  client: ClientInfo,
  options: AuthOptions = {},
): Promise<ChangePasswordResult> {
  const now = nowOf(options);
  assertFreshAuth(auth, now, 'changing the password');
  const throttle = currentThrottle(db, client, now);
  if (throttle.blocked)
    return { ok: false, reason: 'throttled', retryAfterMs: throttle.retryAfterMs };

  const owner = getOwner(db);
  const current =
    typeof input.currentPassword === 'string' && input.currentPassword.length <= MAX_PASSWORD_INPUT
      ? input.currentPassword
      : null;
  const currentOk =
    owner && current !== null
      ? await verifyPassword(owner.passwordHash, current)
      : (await verifyAgainstDummy(current ?? ''), false);
  if (!currentOk) {
    db.transaction((tx) => recordFailure(tx, db, client, 'login', now, session.id));
    return { ok: false, reason: 'invalid_credentials' };
  }

  const next = typeof input.newPassword === 'string' ? input.newPassword : '';
  const policy = checkPassword(next);
  const problems = [...policy.problems];
  if (policy.ok && owner && (await verifyPassword(owner.passwordHash, next))) {
    problems.push('The new password must be different from the current one.');
  }
  if (problems.length > 0) return { ok: false, reason: 'weak_password', problems };

  const hash = await hashPassword(next);
  db.transaction((tx) => {
    updateOwnerPassword(tx, hash, now);
    revokeAllSessions(tx, 'password_changed', now, session.id);
    appendAuthEvent(tx, {
      kind: 'password_changed',
      now,
      sessionId: session.id,
      ip: client.ip,
      userAgent: client.userAgent,
    });
  });
  return { ok: true };
}

/** New set of 10 recovery codes (the old unused ones stop working). Returned formatted, ONCE. */
export function regenerateRecoveryCodes(
  db: Db,
  session: SessionInfo,
  auth: FreshAuth | null | undefined,
  client: ClientInfo,
  options: AuthOptions = {},
): string[] {
  const now = nowOf(options);
  assertFreshAuth(auth, now, 'regenerating the recovery codes');
  const codes = generateRecoveryCodes();
  db.transaction((tx) => {
    replaceRecoveryCodes(tx, codes.map(sha256Hex), now);
    appendAuthEvent(tx, {
      kind: 'recovery_regenerated',
      now,
      sessionId: session.id,
      ip: client.ip,
      userAgent: client.userAgent,
    });
  });
  return codes.map(formatRecoveryCode);
}

/** Ends every session, including this one. */
export function logoutEverywhere(
  db: Db,
  session: SessionInfo,
  auth: FreshAuth | null | undefined,
  client: ClientInfo,
  options: AuthOptions = {},
): number {
  const now = nowOf(options);
  assertFreshAuth(auth, now, 'logging out everywhere');
  return db.transaction((tx) => {
    const n = revokeAllSessions(tx, 'logout_all', now);
    appendAuthEvent(tx, {
      kind: 'logout_all',
      now,
      sessionId: session.id,
      ip: client.ip,
      userAgent: client.userAgent,
      detail: `${n} sessions`,
    });
    return n;
  });
}

/** What the /security page may show about a session: never the token or its hash. */
export interface SessionSummary {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export function getSecurityOverview(db: Reader) {
  const owner = getOwner(db);
  const sessions: SessionSummary[] = listSessions(db, 20).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    ip: s.ip,
    userAgent: s.userAgent,
    revokedAt: s.revokedAt,
    revokedReason: s.revokedReason,
  }));
  return {
    ownerExists: owner !== undefined,
    passwordChangedAt: owner?.passwordChangedAt ?? null,
    unusedRecoveryCodes: countUnusedRecoveryCodes(db),
    events: listAuthEvents(db, 50),
    sessions,
  };
}

// ---- owner set-up (command-line scripts only) ----------------------------------------------------------------

export class OwnerExistsError extends Error {
  constructor() {
    super(
      'An owner already exists. Use "npm run auth:reset" to change the password or re-enrol the authenticator.',
    );
    this.name = 'OwnerExistsError';
  }
}
export class OwnerMissingError extends Error {
  constructor() {
    super('There is no owner yet. Run "npm run auth:create-owner" first.');
    this.name = 'OwnerMissingError';
  }
}
export class PasswordPolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'PasswordPolicyError';
  }
}

export interface EnrolmentResult {
  /** Base32 text for manual entry in an authenticator app. */
  totpSecret: string;
  totpUri: string;
  /** 10 codes, formatted XXXX-XXXX-XXXX-XXXX. Shown once; only hashes are stored. */
  recoveryCodes: string[];
}

async function enrolment(password: string, env: AuthEnv) {
  const policy = checkPassword(password);
  if (!policy.ok) throw new PasswordPolicyError(policy.problems);
  const secret = generateTotpSecret();
  const codes = generateRecoveryCodes();
  return {
    passwordHash: await hashPassword(password),
    totpSecretEnc: encryptTotpSecret(secret, env.secret),
    secret,
    codes,
  };
}

/** Creates THE owner. Refuses if one exists (the database also refuses a second row). */
export async function createOwner(
  db: Db,
  password: string,
  options: AuthOptions = {},
): Promise<EnrolmentResult> {
  const now = nowOf(options);
  const env = options.env ?? getAuthEnv();
  if (getOwner(db)) throw new OwnerExistsError();
  const e = await enrolment(password, env);
  db.transaction((tx) => {
    insertOwner(tx, { passwordHash: e.passwordHash, totpSecretEnc: e.totpSecretEnc, now });
    replaceRecoveryCodes(tx, e.codes.map(sha256Hex), now);
    appendAuthEvent(tx, { kind: 'owner_created', now, detail: 'cli' });
  });
  return {
    totpSecret: e.secret,
    totpUri: totpUri(e.secret),
    recoveryCodes: e.codes.map(formatRecoveryCode),
  };
}

/**
 * Recovery and password reset, run on the machine: new password, new authenticator secret, new
 * recovery codes, and EVERY session ends.
 */
export async function resetOwner(
  db: Db,
  password: string,
  options: AuthOptions = {},
): Promise<EnrolmentResult> {
  const now = nowOf(options);
  const env = options.env ?? getAuthEnv();
  if (!getOwner(db)) throw new OwnerMissingError();
  const e = await enrolment(password, env);
  db.transaction((tx) => {
    updateOwnerPassword(tx, e.passwordHash, now);
    updateOwnerTotp(tx, e.totpSecretEnc, now);
    replaceRecoveryCodes(tx, e.codes.map(sha256Hex), now);
    revokeAllSessions(tx, 'owner_reset', now);
    appendAuthEvent(tx, { kind: 'owner_reset', now, detail: 'cli' });
  });
  return {
    totpSecret: e.secret,
    totpUri: totpUri(e.secret),
    recoveryCodes: e.codes.map(formatRecoveryCode),
  };
}

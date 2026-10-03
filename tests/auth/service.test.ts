import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAuthEnvCache } from '@/auth/env';
import {
  changePassword,
  createOwner,
  currentThrottle,
  freshAuthFor,
  getSecurityOverview,
  login,
  logout,
  logoutEverywhere,
  OwnerExistsError,
  OwnerMissingError,
  PasswordPolicyError,
  regenerateRecoveryCodes,
  resetOwner,
  stepUp,
  verifySession,
  type SessionInfo,
} from '@/auth/service';
import { failureTimes, getOwner, listAuthEvents, listSessions } from '@/data/auth';
import { memoryDb } from '../helpers/db';
import { restartDb } from '../helpers/risk';
import { StepUpRequiredError } from '@/domain/auth/stepup';
import { sha256Hex } from '@/auth/crypto';
import {
  after,
  CLIENT,
  clientFrom,
  codeAt,
  dbWithOwner,
  NEW_PASSWORD,
  PASSWORD,
  T0,
  testEnv,
} from '../helpers/auth';

afterEach(() => {
  resetAuthEnvCache();
  vi.restoreAllMocks();
});

const eventKinds = (db: Parameters<typeof listAuthEvents>[0]) =>
  listAuthEvents(db, 200)
    .map((e) => e.kind)
    .reverse();

/** Logs in as the owner at time `at` and returns the token and session. */
async function loginOk(o: Awaited<ReturnType<typeof dbWithOwner>>, at: Date, client = CLIENT) {
  const r = await login(o.db, { password: PASSWORD, code: codeAt(o.secret, at) }, client, {
    env: o.env,
    now: at,
  });
  if (!r.ok) throw new Error(`login failed: ${JSON.stringify(r)}`);
  const session = verifySession(o.db, r.token, { env: o.env, now: at }) as SessionInfo;
  return { ...r, session };
}

describe('creating the owner (command-line only)', () => {
  it('creates the owner, a secret and 10 recovery codes, and stores no plaintext', async () => {
    const o = await dbWithOwner();
    expect(o.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(o.recoveryCodes).toHaveLength(10);
    for (const c of o.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const owner = getOwner(o.db)!;
    expect(owner.passwordHash).toMatch(/^\$argon2id\$/);
    const stored = JSON.stringify([
      owner,
      o.db.$client.prepare('SELECT * FROM recovery_codes').all(),
    ]);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(o.secret);
    for (const c of o.recoveryCodes) expect(stored).not.toContain(c.replace(/-/g, ''));
    expect(eventKinds(o.db)).toEqual(['owner_created']);
  });

  it('refuses a second owner, and a weak password creates nothing', async () => {
    const o = await dbWithOwner();
    await expect(createOwner(o.db, NEW_PASSWORD, { env: o.env })).rejects.toThrow(OwnerExistsError);
    const db = memoryDb();
    await expect(createOwner(db, 'password1234', { env: testEnv() })).rejects.toThrow(
      PasswordPolicyError,
    );
    expect(getOwner(db)).toBeUndefined();
  });
});

describe('login: password + authenticator code in one step', () => {
  it('succeeds with the right password and the current code; the session counts as freshly verified', async () => {
    const o = await dbWithOwner();
    const { token, session } = await loginOk(o, after(1000));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.stepUpAt).toBe(after(1000).toISOString());
    expect(freshAuthFor(session, after(1000))).not.toBeNull();
    // only the HASH of the token is stored
    const rows = JSON.stringify(o.db.$client.prepare('SELECT * FROM sessions').all());
    expect(rows).not.toContain(token);
    expect(rows).toContain(sha256Hex(token));
    expect(eventKinds(o.db)).toContain('login_success');
  });

  it('gives the SAME generic answer whatever was wrong (password, code, both, no owner)', async () => {
    const o = await dbWithOwner();
    const good = codeAt(o.secret, after(2000));
    const results = [
      await login(o.db, { password: 'wrong password entirely', code: good }, CLIENT, {
        env: o.env,
        now: after(2000),
      }),
      await login(o.db, { password: PASSWORD, code: '000000' }, CLIENT, {
        env: o.env,
        now: after(2001),
      }),
      await login(o.db, { password: 'wrong password entirely', code: '000000' }, CLIENT, {
        env: o.env,
        now: after(2002),
      }),
    ];
    const noOwner = await login(memoryDb(), { password: PASSWORD, code: good }, CLIENT, {
      env: o.env,
      now: after(2003),
    });
    for (const r of [...results, noOwner])
      expect(r).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('logs failures generically: which factor failed is never recorded', async () => {
    const o = await dbWithOwner();
    await login(
      o.db,
      { password: 'wrong password entirely', code: codeAt(o.secret, after(1000)) },
      CLIENT,
      { env: o.env, now: after(1000) },
    );
    await login(o.db, { password: PASSWORD, code: '000000' }, CLIENT, {
      env: o.env,
      now: after(2000),
    });
    const failures = listAuthEvents(o.db).filter((e) => e.kind === 'login_failure');
    expect(failures).toHaveLength(2);
    for (const f of failures) expect(f.detail).toBe('invalid_credentials');
  });

  it('accepts one step of clock drift each way, refuses two', async () => {
    const o = await dbWithOwner();
    const now = after(10_000);
    const early = await login(
      o.db,
      { password: PASSWORD, code: codeAt(o.secret, after(-30_000, now)) },
      CLIENT,
      { env: o.env, now },
    );
    expect(early.ok).toBe(true);
    const o2 = await dbWithOwner();
    const tooOld = await login(
      o2.db,
      { password: PASSWORD, code: codeAt(o2.secret, after(-60_000, now)) },
      CLIENT,
      { env: o2.env, now },
    );
    expect(tooOld.ok).toBe(false);
    const tooEarly = await login(
      o2.db,
      { password: PASSWORD, code: codeAt(o2.secret, after(60_000, now)) },
      CLIENT,
      { env: o2.env, now: after(5000, now) },
    );
    expect(tooEarly.ok).toBe(false);
  });

  it('REPLAY: the same code cannot log in twice; the next code can', async () => {
    const o = await dbWithOwner();
    const code = codeAt(o.secret, after(1000));
    const first = await login(o.db, { password: PASSWORD, code }, CLIENT, {
      env: o.env,
      now: after(1000),
    });
    expect(first.ok).toBe(true);
    const replay = await login(o.db, { password: PASSWORD, code }, CLIENT, {
      env: o.env,
      now: after(1500),
    });
    expect(replay).toEqual({ ok: false, reason: 'invalid_credentials' });
    const next = await login(
      o.db,
      { password: PASSWORD, code: codeAt(o.secret, after(31_000)) },
      CLIENT,
      { env: o.env, now: after(31_000) },
    );
    expect(next.ok).toBe(true);
  });

  it('a failed password does not burn the code (the owner can retry with the same code)', async () => {
    const o = await dbWithOwner();
    const code = codeAt(o.secret, after(1000));
    await login(o.db, { password: 'wrong password entirely', code }, CLIENT, {
      env: o.env,
      now: after(1000),
    });
    expect(getOwner(o.db)?.totpLastStep).toBeNull();
    expect(
      (await login(o.db, { password: PASSWORD, code }, CLIENT, { env: o.env, now: after(2000) }))
        .ok,
    ).toBe(true);
  });

  it('every login gets a NEW session and token (no session fixation)', async () => {
    const o = await dbWithOwner();
    const a = await loginOk(o, after(1000));
    const b = await loginOk(o, after(40_000));
    expect(a.token).not.toBe(b.token);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('survives hostile input without throwing', async () => {
    const o = await dbWithOwner();
    const bad = [
      { password: undefined, code: undefined },
      { password: 12345, code: 123456 },
      { password: 'x'.repeat(5000), code: '123456' },
      { password: PASSWORD, code: 'y'.repeat(500) },
      { password: null, code: null },
      { password: { toString: () => PASSWORD }, code: [] },
    ];
    for (const input of bad) {
      expect(
        await login(o.db, input as never, CLIENT, { env: o.env, now: after(1000) }),
      ).toMatchObject({ ok: false });
    }
  });

  it('fails closed when authentication is not configured (bad or missing AUTH_SECRET)', async () => {
    const o = await dbWithOwner();
    vi.stubEnv('AUTH_SECRET', '');
    resetAuthEnvCache();
    expect(
      await login(o.db, { password: PASSWORD, code: codeAt(o.secret, T0) }, CLIENT, { now: T0 }),
    ).toEqual({ ok: false, reason: 'not_configured' });
    vi.unstubAllEnvs();
  });
});

describe('recovery codes', () => {
  it('log in with password + a recovery code, once; the code is then dead', async () => {
    const o = await dbWithOwner();
    const code = o.recoveryCodes[0]!;
    const r = await login(o.db, { password: PASSWORD, code: code.toLowerCase() }, CLIENT, {
      env: o.env,
      now: after(1000),
    });
    expect(r).toMatchObject({ ok: true, usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect(
      await login(o.db, { password: PASSWORD, code }, CLIENT, { env: o.env, now: after(2000) }),
    ).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(eventKinds(o.db)).toEqual(expect.arrayContaining(['recovery_used', 'login_success']));
  });

  it('using one ends every OTHER session, and the recovery session is not marked as freshly verified', async () => {
    const o = await dbWithOwner();
    const old = await loginOk(o, after(1000));
    const r = await login(o.db, { password: PASSWORD, code: o.recoveryCodes[1]! }, CLIENT, {
      env: o.env,
      now: after(5000),
    });
    expect(r.ok).toBe(true);
    expect(verifySession(o.db, old.token, { env: o.env, now: after(6000) })).toBeNull();
    if (r.ok) {
      const s = verifySession(o.db, r.token, { env: o.env, now: after(6000) })!;
      expect(s.stepUpAt).toBeNull();
      expect(freshAuthFor(s, after(6000))).toBeNull();
    }
  });

  it('a recovery code alone (without the password) never logs in', async () => {
    const o = await dbWithOwner();
    expect(
      (
        await login(
          o.db,
          { password: 'wrong password entirely', code: o.recoveryCodes[2]! },
          CLIENT,
          { env: o.env, now: after(1000) },
        )
      ).ok,
    ).toBe(false);
    // and the failed attempt did not use up the code
    expect(
      (
        await login(o.db, { password: PASSWORD, code: o.recoveryCodes[2]! }, CLIENT, {
          env: o.env,
          now: after(2000),
        })
      ).ok,
    ).toBe(true);
  });

  it('recovery still works if AUTH_SECRET was lost (the authenticator secret is unreadable)', async () => {
    const o = await dbWithOwner();
    const newEnv = testEnv(); // a different AUTH_SECRET
    expect(
      (
        await login(o.db, { password: PASSWORD, code: codeAt(o.secret, after(1000)) }, CLIENT, {
          env: newEnv,
          now: after(1000),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await login(o.db, { password: PASSWORD, code: o.recoveryCodes[0]! }, CLIENT, {
          env: newEnv,
          now: after(2000),
        })
      ).ok,
    ).toBe(true);
  });
});

describe('sessions', () => {
  it('a valid session is recognised; tampered, random, revoked and malformed tokens are not', async () => {
    const o = await dbWithOwner();
    const { token, session } = await loginOk(o, after(1000));
    expect(verifySession(o.db, token, { env: o.env, now: after(2000) })?.id).toBe(session.id);
    const flip = (t: string) =>
      t[5] === 'A' ? t.slice(0, 5) + 'B' + t.slice(6) : t.slice(0, 5) + 'A' + t.slice(6);
    for (const bad of [
      flip(token),
      token + 'x',
      token.slice(0, -1),
      '',
      'short',
      'x'.repeat(200),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(verifySession(o.db, bad, { env: o.env, now: after(2000) }), String(bad)).toBeNull();
    }
  });

  it('idle timeout: valid 1 ms before 2 hours of inactivity, over exactly at 2 hours, and revoked', async () => {
    const o = await dbWithOwner();
    const { token } = await loginOk(o, after(1000));
    const idle = 2 * 3600_000;
    expect(verifySession(o.db, token, { env: o.env, now: after(1000 + idle - 1) })).not.toBeNull();
    // that call refreshed last-seen; use a fresh login for the exact boundary
    const o2 = await dbWithOwner();
    const b = await loginOk(o2, after(1000));
    expect(verifySession(o2.db, b.token, { env: o2.env, now: after(1000 + idle) })).toBeNull();
    expect(listSessions(o2.db)[0]).toMatchObject({ revokedReason: 'expired_idle' });
    expect(eventKinds(o2.db)).toContain('session_revoked');
    // ...and it stays dead
    expect(verifySession(o2.db, b.token, { env: o2.env, now: after(1001) })).toBeNull();
  });

  it('absolute lifetime: a busy session still ends 12 hours after login', async () => {
    const o = await dbWithOwner();
    const { token } = await loginOk(o, after(0));
    const hour = 3600_000;
    for (let h = 1; h <= 11; h++)
      expect(
        verifySession(o.db, token, { env: o.env, now: after(h * hour) }),
        `hour ${h}`,
      ).not.toBeNull();
    expect(verifySession(o.db, token, { env: o.env, now: after(12 * hour - 1) })).not.toBeNull();
    expect(verifySession(o.db, token, { env: o.env, now: after(12 * hour) })).toBeNull();
    expect(listSessions(o.db)[0]).toMatchObject({ revokedReason: 'expired_absolute' });
  });

  it('last-seen is saved at most once a minute', async () => {
    const o = await dbWithOwner();
    const { token } = await loginOk(o, after(0));
    verifySession(o.db, token, { env: o.env, now: after(30_000) });
    expect(listSessions(o.db)[0]!.lastSeenAt).toBe(after(0).toISOString());
    verifySession(o.db, token, { env: o.env, now: after(60_000) });
    expect(listSessions(o.db)[0]!.lastSeenAt).toBe(after(60_000).toISOString());
  });

  it('logout destroys the session', async () => {
    const o = await dbWithOwner();
    const { token, session } = await loginOk(o, after(0));
    logout(o.db, session, CLIENT, { now: after(1000) });
    expect(verifySession(o.db, token, { env: o.env, now: after(2000) })).toBeNull();
    expect(eventKinds(o.db)).toContain('logout');
  });
});

describe('step-up (a fresh code within 5 minutes)', () => {
  it('login counts as fresh; it goes stale after 5 minutes; a new code makes it fresh again', async () => {
    const o = await dbWithOwner();
    const { token } = await loginOk(o, after(0));
    const at = (ms: number) => verifySession(o.db, token, { env: o.env, now: after(ms) })!;
    expect(freshAuthFor(at(299_999), after(299_999))).not.toBeNull();
    expect(freshAuthFor(at(300_000), after(300_000))).toBeNull();
    const session = at(300_000);
    const r = stepUp(o.db, session, codeAt(o.secret, after(330_000)), CLIENT, {
      env: o.env,
      now: after(330_000),
    });
    expect(r.ok).toBe(true);
    expect(
      freshAuthFor(
        verifySession(o.db, token, { env: o.env, now: after(331_000) })!,
        after(331_000),
      ),
    ).not.toBeNull();
    expect(eventKinds(o.db)).toContain('step_up_success');
  });

  it('REPLAY: the code used to log in cannot be used again for step-up', async () => {
    const o = await dbWithOwner();
    const { session } = await loginOk(o, after(0));
    const loginCode = codeAt(o.secret, after(0));
    expect(stepUp(o.db, session, loginCode, CLIENT, { env: o.env, now: after(5000) })).toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
  });

  it('refuses wrong codes, malformed input and recovery codes, and logs the failure', async () => {
    const o = await dbWithOwner();
    const { session } = await loginOk(o, after(0));
    for (const bad of ['000000', '', 'abcdef', o.recoveryCodes[0]!, null, 123456]) {
      expect(
        stepUp(o.db, session, bad, CLIENT, { env: o.env, now: after(60_000) }),
        String(bad),
      ).toMatchObject({ ok: false });
    }
    expect(eventKinds(o.db)).toContain('step_up_failure');
  });
});

describe('security settings need a fresh code', () => {
  async function freshSession() {
    const o = await dbWithOwner();
    const { session, token } = await loginOk(o, after(0));
    const proof = freshAuthFor(session, after(1000))!;
    return { ...o, session, token, proof };
  }

  it('change password: needs the proof, the current password, and a strong different password', async () => {
    const o = await freshSession();
    const opts = { env: o.env, now: after(1000) };
    await expect(
      changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        null,
        CLIENT,
        opts,
      ),
    ).rejects.toThrow(StepUpRequiredError);
    expect(
      await changePassword(
        o.db,
        o.session,
        { currentPassword: 'wrong password entirely', newPassword: NEW_PASSWORD },
        o.proof,
        CLIENT,
        opts,
      ),
    ).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(
      await changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: 'password1234' },
        o.proof,
        CLIENT,
        opts,
      ),
    ).toMatchObject({ ok: false, reason: 'weak_password' });
    expect(
      await changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: PASSWORD },
        o.proof,
        CLIENT,
        opts,
      ),
    ).toMatchObject({ ok: false, reason: 'weak_password' });
    expect(
      await changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        o.proof,
        CLIENT,
        opts,
      ),
    ).toEqual({ ok: true });
    expect(eventKinds(o.db)).toContain('password_changed');
  });

  it('a stale proof (older than 5 minutes) is refused', async () => {
    const o = await freshSession();
    await expect(
      changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        o.proof,
        CLIENT,
        { env: o.env, now: after(1000 + 300_000) },
      ),
    ).rejects.toThrow(StepUpRequiredError);
  });

  it('after a password change the NEW password works, the old one does not, and other sessions end', async () => {
    const o = await freshSession();
    const other = await loginOk(o, after(40_000));
    expect(
      await changePassword(
        o.db,
        o.session,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        o.proof,
        CLIENT,
        { env: o.env, now: after(1000) },
      ),
    ).toEqual({ ok: true });
    expect(verifySession(o.db, other.token, { env: o.env, now: after(2000) })).toBeNull(); // other session revoked
    expect(verifySession(o.db, o.token, { env: o.env, now: after(2000) })).not.toBeNull(); // this one stays
    const code = codeAt(o.secret, after(80_000));
    expect(
      (await login(o.db, { password: PASSWORD, code }, CLIENT, { env: o.env, now: after(80_000) }))
        .ok,
    ).toBe(false);
    expect(
      (
        await login(o.db, { password: NEW_PASSWORD, code }, CLIENT, {
          env: o.env,
          now: after(81_000),
        })
      ).ok,
    ).toBe(true);
  });

  it('regenerating recovery codes needs the proof, gives 10 new codes, and kills the old unused ones', async () => {
    const o = await freshSession();
    expect(() =>
      regenerateRecoveryCodes(o.db, o.session, null, CLIENT, { now: after(1000) }),
    ).toThrow(StepUpRequiredError);
    const fresh = regenerateRecoveryCodes(o.db, o.session, o.proof, CLIENT, { now: after(1000) });
    expect(fresh).toHaveLength(10);
    expect(
      (
        await login(o.db, { password: PASSWORD, code: o.recoveryCodes[0]! }, CLIENT, {
          env: o.env,
          now: after(2000),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await login(o.db, { password: PASSWORD, code: fresh[0]! }, CLIENT, {
          env: o.env,
          now: after(3000),
        })
      ).ok,
    ).toBe(true);
    expect(eventKinds(o.db)).toContain('recovery_regenerated');
  });

  it('log out everywhere needs the proof and ends every session including this one', async () => {
    const o = await freshSession();
    const other = await loginOk(o, after(40_000));
    expect(() => logoutEverywhere(o.db, o.session, null, CLIENT, { now: after(1000) })).toThrow(
      StepUpRequiredError,
    );
    expect(logoutEverywhere(o.db, o.session, o.proof, CLIENT, { now: after(1000) })).toBe(2);
    expect(verifySession(o.db, o.token, { env: o.env, now: after(2000) })).toBeNull();
    expect(verifySession(o.db, other.token, { env: o.env, now: after(2000) })).toBeNull();
    expect(eventKinds(o.db)).toContain('logout_all');
  });

  it('a proof forged by hand is refused', async () => {
    const o = await freshSession();
    const forged = { sessionId: o.session.id, verifiedAt: after(1000).toISOString() } as never;
    expect(() =>
      regenerateRecoveryCodes(o.db, o.session, forged, CLIENT, { now: after(1000) }),
    ).toThrow(StepUpRequiredError);
  });
});

describe('progressive delays (never a permanent lockout)', () => {
  const fail = (o: Awaited<ReturnType<typeof dbWithOwner>>, at: Date, client = CLIENT) =>
    login(o.db, { password: 'wrong password entirely', code: '000000' }, client, {
      env: o.env,
      now: at,
    });

  it('four failures are free; the 5th starts a 5 second delay', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 4; i++)
      expect(await fail(o, after(i * 1000))).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(currentThrottle(o.db, CLIENT, after(3000)).blocked).toBe(false);
    expect(await fail(o, after(4000))).toEqual({ ok: false, reason: 'invalid_credentials' }); // the 5th is still processed...
    expect(currentThrottle(o.db, CLIENT, after(4000))).toEqual({
      blocked: true,
      retryAfterMs: 5000,
    }); // ...and starts the delay
    expect(eventKinds(o.db).filter((k) => k === 'rate_limit_tripped')).toHaveLength(1);
  });

  it('during the delay even CORRECT credentials are rejected without being checked, and are NOT counted', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 5; i++) await fail(o, after(i * 100));
    const before = failureTimes(o.db, 'global', 0).length;
    const good = { password: PASSWORD, code: codeAt(o.secret, after(1000)) };
    const r = await login(o.db, good, CLIENT, { env: o.env, now: after(1000) });
    expect(r).toMatchObject({ ok: false, reason: 'throttled' });
    expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(failureTimes(o.db, 'global', 0)).toHaveLength(before); // not counted
    expect(getOwner(o.db)?.totpLastStep).toBeNull(); // the code was not even looked at
  });

  it('hammering during the delay cannot extend it, so the owner gets in when it ends', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 5; i++) await fail(o, after(i * 100)); // 5th failure at +400 ms -> delay until +5400 ms
    for (let ms = 500; ms < 5400; ms += 250) {
      expect(await fail(o, after(ms)), `attacker at +${ms}`).toMatchObject({ reason: 'throttled' });
    }
    const code = codeAt(o.secret, after(5400));
    const ok = await login(o.db, { password: PASSWORD, code }, CLIENT, {
      env: o.env,
      now: after(5400),
    });
    expect(ok.ok).toBe(true); // exactly when the delay ends
  });

  it('the delay grows (5 s, 10 s, 20 s) but is always finite', async () => {
    const o = await dbWithOwner();
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await fail(o, after(t));
      const s = currentThrottle(o.db, CLIENT, after(t));
      if (s.blocked) {
        waits.push(s.retryAfterMs);
        t += s.retryAfterMs; // wait it out
      } else t += 1000;
    }
    expect(waits.slice(0, 3)).toEqual([5000, 10_000, 20_000]);
    for (const w of waits) expect(w).toBeLessThanOrEqual(15 * 60_000);
  });

  it('survives a restart: the delay is still in force afterwards', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 5; i++) await fail(o, after(i * 100));
    const restarted = restartDb(o.db);
    expect(currentThrottle(restarted, CLIENT, after(1000)).blocked).toBe(true);
    const r = await login(
      restarted,
      { password: PASSWORD, code: codeAt(o.secret, after(1000)) },
      CLIENT,
      { env: o.env, now: after(1000) },
    );
    expect(r).toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('NO PERMANENT LOCKOUT: after a long attack, the owner can log in once time has passed', async () => {
    const o = await dbWithOwner();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      await fail(o, after(t));
      const s = currentThrottle(o.db, CLIENT, after(t));
      t += s.blocked ? s.retryAfterMs : 100;
    }
    const later = after(t + 16 * 60_000);
    const r = await login(o.db, { password: PASSWORD, code: codeAt(o.secret, later) }, CLIENT, {
      env: o.env,
      now: later,
    });
    expect(r.ok).toBe(true);
  });

  it('failures age out after an hour', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 6; i++) await fail(o, after(i * 100));
    const much = after(61 * 60_000);
    expect(currentThrottle(o.db, CLIENT, much).blocked).toBe(false);
  });

  it("a successful login clears that source's failures", async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 3; i++) await fail(o, after(i * 100));
    await loginOk(o, after(1000));
    expect(failureTimes(o.db, 'source:direct', 0)).toEqual([]);
  });

  it('the GLOBAL limit protects against attackers that use many sources', async () => {
    const o = await dbWithOwner();
    for (let i = 0; i < 21; i++) await fail(o, after(i * 10), clientFrom(`10.0.0.${i}`)); // each source fails only once
    const fresh = clientFrom('10.9.9.9');
    expect(currentThrottle(o.db, fresh, after(500)).blocked).toBe(true); // a brand-new source is slowed too
    expect(await fail(o, after(500), fresh)).toMatchObject({ reason: 'throttled' });
    expect(currentThrottle(o.db, fresh, after(500 + 300_000)).blocked).toBe(false); // and it ends
  });

  it('step-up attempts share the same limiter', async () => {
    const o = await dbWithOwner();
    const { session } = await loginOk(o, after(0));
    for (let i = 0; i < 5; i++)
      stepUp(o.db, session, '000000', CLIENT, { env: o.env, now: after(100_000 + i * 100) });
    const r = stepUp(o.db, session, codeAt(o.secret, after(160_000)), CLIENT, {
      env: o.env,
      now: after(101_000),
    });
    expect(r).toMatchObject({ ok: false, reason: 'throttled' });
  });
});

describe('owner reset (command line)', () => {
  it('needs an existing owner', async () => {
    await expect(resetOwner(memoryDb(), NEW_PASSWORD, { env: testEnv() })).rejects.toThrow(
      OwnerMissingError,
    );
  });

  it('sets a new password, authenticator and recovery codes, and ends every session', async () => {
    const o = await dbWithOwner();
    const old = await loginOk(o, after(1000));
    const e = await resetOwner(o.db, NEW_PASSWORD, { env: o.env, now: after(5000) });
    expect(e.totpSecret).not.toBe(o.secret);
    expect(verifySession(o.db, old.token, { env: o.env, now: after(6000) })).toBeNull();
    expect(getOwner(o.db)?.totpLastStep).toBeNull();
    // old credentials are dead
    expect(
      (
        await login(
          o.db,
          { password: PASSWORD, code: codeAt(e.totpSecret, after(40_000)) },
          CLIENT,
          { env: o.env, now: after(40_000) },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await login(
          o.db,
          { password: NEW_PASSWORD, code: codeAt(o.secret, after(80_000)) },
          CLIENT,
          { env: o.env, now: after(80_000) },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await login(
          o.db,
          { password: NEW_PASSWORD, code: codeAt(e.totpSecret, after(120_000)) },
          CLIENT,
          { env: o.env, now: after(120_000) },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await login(o.db, { password: NEW_PASSWORD, code: o.recoveryCodes[0]! }, CLIENT, {
          env: o.env,
          now: after(130_000),
        })
      ).ok,
    ).toBe(false); // old recovery codes dead
    expect(eventKinds(o.db)).toContain('owner_reset');
  });

  it('a weak new password changes nothing', async () => {
    const o = await dbWithOwner();
    await expect(resetOwner(o.db, 'password1234', { env: o.env })).rejects.toThrow(
      PasswordPolicyError,
    );
    expect((await loginOk(o, after(1000))).ok).toBe(true);
  });
});

describe('secrets never appear in the log or the console', () => {
  it('after a full tour of the features, no password, code, token or secret is stored in the event log or printed', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const o = await dbWithOwner();
    const good = codeAt(o.secret, after(1000));
    await login(o.db, { password: 'wrong password entirely', code: good }, CLIENT, {
      env: o.env,
      now: after(500),
    });
    const { token, session } = await loginOk(o, after(1000));
    stepUp(o.db, session, '000000', CLIENT, { env: o.env, now: after(2000) });
    const proof = freshAuthFor(session, after(3000))!;
    const fresh = regenerateRecoveryCodes(o.db, session, proof, CLIENT, { now: after(3000) });
    await changePassword(
      o.db,
      session,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      proof,
      CLIENT,
      { env: o.env, now: after(3500) },
    );
    logout(o.db, session, CLIENT, { now: after(4000) });

    const everything = JSON.stringify([
      o.db.$client.prepare('SELECT * FROM auth_events').all(),
      o.db.$client.prepare('SELECT * FROM auth_attempts').all(),
      getSecurityOverview(o.db),
      spies.flatMap((s) => s.mock.calls),
    ]);
    const secrets = [
      PASSWORD,
      NEW_PASSWORD,
      'wrong password entirely',
      good,
      token,
      sha256Hex(token),
      o.secret,
      o.env.secret,
      ...o.recoveryCodes,
      ...fresh,
      ...o.recoveryCodes.map((c) => c.replace(/-/g, '')),
    ];
    for (const s of secrets) expect(everything, s.slice(0, 6)).not.toContain(s);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthEnv, resetAuthEnvCache } from '@/auth/env';
import { login } from '@/auth/service';
import { createAccount } from '@/data/accounts';
import { listAuthEvents } from '@/data/auth';
import type { Db } from '@/data/client';
import { getNotificationSettings, insertEvents, readAllState } from '@/data/notifications';
import { makeEvent } from '@/domain/notifications';
import { CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import { enableAlerts, failSend, fakeChannel, type FakeChannel } from '../helpers/notifications';

vi.setConfig({ testTimeout: 30_000 });

const request = {
  headers: {} as Record<string, string>,
  cookies: {} as Record<string, string>,
  db: undefined as Db | undefined,
};
const rt = { channel: undefined as FakeChannel | undefined, configured: true };

vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.headers),
  cookies: async () => ({
    get: (name: string) => (name in request.cookies ? { value: request.cookies[name] } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('@/data/client', async (original) => ({
  ...(await original<typeof import('@/data/client')>()),
  getDb: () => request.db,
}));
// The real runtime would build a network channel from the token; tests always use the fake one.
vi.mock('@/notifications/runtime', () => ({
  getChannelRuntime: () =>
    rt.configured
      ? { channel: rt.channel ?? null, configured: true, message: null }
      : {
          channel: null,
          configured: false,
          message: 'Telegram is not set up. Run "npm run notify:set-telegram".',
        },
}));

const sameSite = {
  host: '127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'test-browser',
};

let secret = '';
beforeEach(async () => {
  process.env.AUTH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString(
    'base64url',
  );
  resetAuthEnvCache();
  const owner = await dbWithOwner(getAuthEnv());
  request.db = owner.db;
  secret = owner.secret;
  request.headers = { ...sameSite };
  createAccount(owner.db, { name: 'Paper', baseCurrency: 'USDT', startingBalance: '10000' });
  const r = await login(
    owner.db,
    { password: PASSWORD, code: codeAt(secret, new Date()) },
    CLIENT,
    { now: new Date() },
  );
  if (!r.ok) throw new Error('sign-in failed');
  request.cookies = { houcine_session: r.token };
  owner.db.$client.prepare('UPDATE sessions SET step_up_at = NULL').run(); // the actions must ask for a code
  rt.channel = fakeChannel();
  rt.configured = true;
});
afterEach(() => {
  resetAuthEnvCache();
  delete process.env.AUTH_SECRET;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const url = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return decodeURIComponent((e as { url?: string }).url ?? '');
  }
  return '';
};
const db = () => request.db as Db;
// The sign-in used the current 30-second step; the NEXT step is the one code the test can still use.
const nextCode = () => codeAt(secret, new Date(Date.now() + 30_000));
const kinds = () => listAuthEvents(db()).map((e) => e.kind);

describe('the master switch (action layer)', () => {
  it('is OFF by default', () => {
    expect(getNotificationSettings(db()).master).toBe(false);
  });

  it('ON needs the consent box, a configured channel AND a fresh code', async () => {
    const a = await import('@/app/notifications/actions');
    expect(await url(a.setMasterAction(form({ master: 'on', stepUpCode: nextCode() })))).toContain(
      'Tick the box',
    );
    expect(await url(a.setMasterAction(form({ master: 'on', understood: 'yes' })))).toContain(
      'fresh authenticator code',
    );
    expect(
      await url(a.setMasterAction(form({ master: 'on', understood: 'yes', stepUpCode: '000000' }))),
    ).toContain('not accepted');
    rt.configured = false;
    expect(
      await url(
        a.setMasterAction(form({ master: 'on', understood: 'yes', stepUpCode: nextCode() })),
      ),
    ).toContain('not set up');
    expect(getNotificationSettings(db()).master).toBe(false);
    expect(kinds()).not.toContain('notifications_on');
  });

  it('ON with everything is accepted, logged, and stores the baseline', async () => {
    const a = await import('@/app/notifications/actions');
    const r = await url(
      a.setMasterAction(form({ master: 'on', understood: 'yes', stepUpCode: nextCode() })),
    );
    expect(r).toContain('Alerts are ON');
    expect(getNotificationSettings(db()).master).toBe(true);
    expect(kinds()).toContain('notifications_on');
    expect(Object.keys(readAllState(db()))).toEqual(expect.arrayContaining(['wm:risk', 'wm:auth']));
  });

  it('OFF ALSO needs a fresh code, then takes effect and sends exactly one last notice', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    db().$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
    expect(await url(a.setMasterAction(form({ master: 'off' })))).toContain(
      'fresh authenticator code',
    );
    expect(getNotificationSettings(db()).master).toBe(true);
    const off = await url(a.setMasterAction(form({ master: 'off', stepUpCode: nextCode() })));
    expect(off).toContain('Alerts are OFF');
    expect(getNotificationSettings(db()).master).toBe(false);
    expect(rt.channel?.sent).toEqual(['Houcine.Trades (paper): Alerts were switched off.']);
    expect(kinds()).toEqual(expect.arrayContaining(['notifications_on', 'notifications_off']));
  });

  it('OFF still works when the channel is broken (the failure never blocks it)', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    rt.channel = fakeChannel(new Error('boom'));
    db().$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
    expect(await url(a.setMasterAction(form({ master: 'off', stepUpCode: nextCode() })))).toContain(
      'Alerts are OFF',
    );
    expect(getNotificationSettings(db()).master).toBe(false);
  });
});

describe('settings (action layer)', () => {
  const all = {
    cat_risk: 'on',
    cat_security: 'on',
    cat_analyst: 'on',
    cat_system: 'on',
    minSeverity: 'info',
  };
  it('louder needs no code; quieter needs one and waits 24 hours', async () => {
    const a = await import('@/app/notifications/actions');
    expect(await url(a.updateSettingsAction(form({ ...all, cat_analyst: '' })))).toContain(
      'fresh authenticator code',
    );
    expect(getNotificationSettings(db()).effective?.categories.analyst).toBe(true);
    const ok = await url(
      a.updateSettingsAction(form({ ...all, cat_analyst: '', stepUpCode: nextCode() })),
    );
    expect(ok).toContain('Waiting 24 hours');
    expect(getNotificationSettings(db()).effective?.categories.analyst).toBe(true);
    // back to louder cancels it, with no new code needed
    const cancel = await url(a.updateSettingsAction(form(all)));
    expect(cancel).toContain('Cancelled pending change');
    expect(kinds()).toContain('notifications_settings_changed');
  });
  it('rejects an unknown severity', async () => {
    const a = await import('@/app/notifications/actions');
    expect(await url(a.updateSettingsAction(form({ ...all, minSeverity: 'loud' })))).toContain(
      'not a severity',
    );
  });
});

describe('test message and "Deliver now"', () => {
  it('the test message is refused while alerts are OFF and sends nothing', async () => {
    const a = await import('@/app/notifications/actions');
    expect(await url(a.testMessageAction())).toContain('Alerts are OFF');
    expect(rt.channel?.calls).toBe(0);
  });
  it('the test message arrives when alerts are ON', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    expect(await url(a.testMessageAction())).toContain('test message was sent');
    expect(rt.channel?.sent).toEqual([
      'Houcine.Trades (paper): Test message. If you can read this, alerts reach you.',
    ]);
  });
  it('a failed test message explains in plain words, never with the channel text', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    rt.channel = fakeChannel(failSend('forbidden'));
    const r = await url(a.testMessageAction());
    expect(r).toContain('refused to deliver to this chat');
  });
  it('"Deliver now" sends what is waiting; with a channel that throws it still just redirects', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    insertEvents(
      db(),
      [makeEvent({ kind: 'login_success', dedupeKey: 'k', occurredAt: new Date().toISOString() })],
      new Date(),
    );
    expect(await url(a.deliverNowAction())).toContain('1 sent');
    insertEvents(
      db(),
      [
        makeEvent({
          kind: 'password_changed',
          dedupeKey: 'k2',
          occurredAt: new Date().toISOString(),
        }),
      ],
      new Date(),
    );
    rt.channel = fakeChannel(new Error('boom https://api.telegram.org/bot1:SECRET/x'));
    const r = await url(a.deliverNowAction());
    expect(r).toContain('1 failed');
    expect(r).not.toContain('SECRET');
  });
  it('"Deliver now" without Telegram says so', async () => {
    const a = await import('@/app/notifications/actions');
    rt.configured = false;
    expect(await url(a.deliverNowAction())).toContain('not set up');
  });
});

describe('more action-layer rules', () => {
  it('switching ON again while ON changes nothing', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    const before = JSON.stringify(readAllState(db()));
    db().$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
    await url(a.setMasterAction(form({ master: 'on', understood: 'yes', stepUpCode: nextCode() })));
    expect(JSON.stringify(readAllState(db()))).toBe(before);
  });
  it('ON is refused when the current state cannot be read (it would announce old levels as new)', async () => {
    const a = await import('@/app/notifications/actions');
    db().$client.exec('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    const r = await url(
      a.setMasterAction(form({ master: 'on', understood: 'yes', stepUpCode: nextCode() })),
    );
    expect(r).toContain('cannot be turned on yet');
    expect(getNotificationSettings(db()).master).toBe(false);
  });
  it('OFF tells the truth about the final notice', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    db().$client.prepare('UPDATE sessions SET step_up_at = NULL').run();
    const sent = await url(a.setMasterAction(form({ master: 'off', stepUpCode: nextCode() })));
    expect(sent).toContain('"Alerts were switched off", was sent');
    // and when the channel is not set up
    enableAlerts(db(), new Date());
    getNotificationSettings(db());
    db().$client.prepare('UPDATE notification_settings SET master = 1').run();
    rt.configured = false;
    db().$client.prepare('UPDATE sessions SET step_up_at = ?').run(new Date().toISOString());
    const notSent = await url(a.setMasterAction(form({ master: 'off' })));
    expect(notSent).toContain('could not be sent right now');
    expect(notSent).not.toContain('was sent');
  });
  it('the test message is limited to one a minute', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    expect(await url(a.testMessageAction())).toContain('test message was sent');
    expect(await url(a.testMessageAction())).toContain('Wait a minute');
    expect(rt.channel?.calls).toBe(1);
  });
  it('"Deliver now" names the problems instead of just saying "Done"', async () => {
    const a = await import('@/app/notifications/actions');
    enableAlerts(db(), new Date());
    db().$client.prepare("UPDATE ai_settings SET caps_json = 'junk'").run();
    db().$client.exec(
      "INSERT OR REPLACE INTO ai_settings (id, consent, caps_json, updated_at) VALUES (1, 0, 'junk', 't')",
    );
    expect(await url(a.deliverNowAction())).toContain('with problems: analyst_settings');
  });
});

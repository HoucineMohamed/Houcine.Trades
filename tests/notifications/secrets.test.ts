import { describe, expect, it, vi } from 'vitest';
import { insertEvents } from '@/data/notifications';
import { makeEvent } from '@/domain/notifications';
import { createTelegramChannel } from '@/integrations/telegram/client';
import { deliverPending, sendTestMessage } from '@/notifications/delivery';
import { runCycle } from '@/notifications/worker';
import { enableAlerts, fakeBotToken, fakeChatId } from '../helpers/notifications';
import { riskDb } from '../helpers/risk';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const opts = { clock: () => new Date(T0.getTime() + 1000), sleep: async () => undefined };
const dump = (db: ReturnType<typeof riskDb>) =>
  Buffer.from(db.$client.serialize()).toString('latin1');

/** Every way a transport can fail while carrying the token (it is inside the URL). */
const hostileFetches: Record<
  string,
  (token: string, chat: string) => (url: string, init: RequestInit) => Promise<Response>
> = {
  'throws an error that contains the URL': () => async (url) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND for ${url}`), { url, config: { url } });
  },
  'throws an error that contains the token and chat id': (token, chat) => async () => {
    throw new Error(`token=${token} chat=${chat}`);
  },
  'a 400 that echoes the URL and the body': () => async (url, init) =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: `Bad request ${url} ${String(init.body)}`,
      }),
      { status: 400 },
    ),
  'a 200 with junk that echoes the token': (token) => async () =>
    new Response(`<html>${token}</html>`, { status: 200 }),
  'a 429': () => async () =>
    new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 7 } }), {
      status: 429,
    }),
  'a hang that is aborted': () => (url, init) =>
    new Promise<Response>((_res, reject) =>
      init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`))),
    ),
};

describe('the bot token and chat id never leak, however the transport fails', () => {
  for (const [name, make] of Object.entries(hostileFetches)) {
    it(name, async () => {
      const token = fakeBotToken();
      const chat = fakeChatId();
      const db = riskDb();
      enableAlerts(db, T0);
      insertEvents(
        db,
        [makeEvent({ kind: 'login_success', dedupeKey: 'k', occurredAt: T0.toISOString() })],
        T0,
      );
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      const channel = createTelegramChannel({
        token,
        chatId: chat,
        fetchImpl: make(token, chat),
        timeoutMs: 15,
      });

      const report = await deliverPending(db, channel, opts);
      const cycle = await runCycle(db, channel, {
        ...opts,
        clock: () => new Date(T0.getTime() + 2_000_000),
      });
      const test = await sendTestMessage(db, channel, {
        ...opts,
        clock: () => new Date(T0.getTime() + 4_000_000),
      });

      for (const out of [report, cycle, test]) {
        const text = JSON.stringify(out);
        expect(text).not.toContain(token);
        expect(text).not.toContain(token.split(':')[1] as string);
        expect(text).not.toContain(chat);
        expect(text).not.toContain('api.telegram.org');
      }
      const records = dump(db);
      expect(records).not.toContain(token);
      expect(records).not.toContain(token.split(':')[1] as string);
      expect(records).not.toContain(chat);
      expect(records).not.toContain('api.telegram.org');
      expect(records).not.toContain('Bad request');
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      // and every stored failure is one of the short codes
      const codes = (
        db.$client
          .prepare(
            "SELECT DISTINCT error_code FROM notification_deliveries WHERE status = 'failed'",
          )
          .all() as { error_code: string }[]
      ).map((r) => r.error_code);
      for (const c of codes)
        expect(['timeout', 'network', 'bad_request', 'bad_response', 'rate_limited']).toContain(c);
    });
  }

  it('the real runtime keeps the token inside the adapter: not in its description, not enumerable', async () => {
    const token = fakeBotToken();
    const channel = createTelegramChannel({
      token,
      chatId: fakeChatId(),
      fetchImpl: async () => new Response('{}'),
    });
    expect(JSON.stringify(channel)).not.toContain(token);
    expect(Object.keys(channel).sort()).toEqual(['name', 'send']);
    expect(String(channel.send)).not.toContain(token);
  });
});

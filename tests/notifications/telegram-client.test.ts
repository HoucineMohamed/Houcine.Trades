import { describe, expect, it } from 'vitest';
import {
  API_HOST,
  createTelegramChannel,
  createTelegramPairingSource,
} from '@/integrations/telegram/client';
import { parseTelegramEnv } from '@/integrations/telegram/env';
import { fakeBotToken, fakeChatId } from '../helpers/notifications';

interface Call {
  url: string;
  init: RequestInit;
}
function stub(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return respond(c);
    },
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OK = { ok: true, result: { message_id: 1 } };

const make = (respond: (c: Call) => Response | Promise<Response>, timeoutMs = 1000) => {
  const token = fakeBotToken();
  const chatId = fakeChatId();
  const s = stub(respond);
  return {
    token,
    chatId,
    s,
    channel: createTelegramChannel({ token, chatId, fetchImpl: s.fetch, timeoutMs }),
  };
};

describe('sendMessage: the request', () => {
  it('is ONE POST to the fixed host with only the chat and the text (plain text: no parse mode, no markup)', async () => {
    const { token, chatId, s, channel } = make(() => json(200, OK));
    expect(await channel.send('Hello')).toEqual({ ok: true });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0] as Call;
    expect(call.url).toBe(`${API_HOST}/bot${token}/sendMessage`);
    expect(API_HOST).toBe('https://api.telegram.org');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(JSON.parse(call.init.body as string)).toEqual({
      chat_id: Number(chatId),
      text: 'Hello',
    });
    expect(call.init.body as string).not.toContain(token);
  });
  it('refuses an empty or too long text without calling', async () => {
    const { s, channel } = make(() => json(200, OK));
    expect(await channel.send('')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await channel.send('x'.repeat(4097))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(s.calls).toHaveLength(0);
  });
  it('does not retry: a failure is exactly one call', async () => {
    const { s, channel } = make(() => json(500, { ok: false, error_code: 500 }));
    expect(await channel.send('x')).toMatchObject({ ok: false, code: 'server_error' });
    expect(s.calls).toHaveLength(1);
  });
});

describe('sendMessage: replies (anything unexpected is a failure)', () => {
  const send = async (res: () => Response) => make(res).channel.send('x');
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [400, 'bad_request'],
    [404, 'bad_request'],
    [500, 'server_error'],
    [502, 'server_error'],
  ])('HTTP %s is %s', async (status, code) => {
    expect(
      await send(() => json(status, { ok: false, error_code: status, description: 'x' })),
    ).toMatchObject({ ok: false, code });
  });
  it('a 200 whose body is not exactly {ok:true, result:{...}} is NOT a success', async () => {
    for (const body of [
      {},
      { ok: true },
      { ok: true, result: 'x' },
      { ok: true, result: [] },
      { ok: true, result: null },
      { ok: 'true', result: {} },
      'nope',
      null,
      [],
    ]) {
      expect(await send(() => json(200, body)), JSON.stringify(body)).toMatchObject({
        ok: false,
        code: 'bad_response',
      });
    }
    expect(await send(() => new Response('<html>', { status: 200 }))).toMatchObject({
      ok: false,
      code: 'bad_response',
    });
  });
  it('ok:false inside a 200 is a failure, mapped by its error code when it has one', async () => {
    expect(await send(() => json(200, { ok: false, error_code: 403 }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await send(() => json(200, { ok: false }))).toMatchObject({
      ok: false,
      code: 'bad_response',
    });
  });
  it('reads a retry-after only when it is a sane whole number of seconds', async () => {
    const r = (v: unknown) =>
      send(() => json(429, { ok: false, error_code: 429, parameters: { retry_after: v } }));
    expect(await r(17)).toEqual({ ok: false, code: 'rate_limited', retryAfterS: 17 });
    for (const bad of [0, -3, 1.5, 'soon', 999_999, null])
      expect(await r(bad)).toMatchObject({ retryAfterS: null });
  });
  it('a non-JSON error body is still a plain coded failure', async () => {
    expect(await send(() => new Response('Bad Gateway', { status: 502 }))).toMatchObject({
      ok: false,
      code: 'server_error',
    });
  });
});

describe('the token never leaves the adapter', () => {
  it('an error that CONTAINS the URL is reduced to a short code', async () => {
    const token = fakeBotToken();
    const failing = async (url: string) => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${url} (request to ${url} failed)`), {
        url,
        cause: { url },
      });
    };
    const channel = createTelegramChannel({ token, chatId: fakeChatId(), fetchImpl: failing });
    const r = await channel.send('x');
    expect(r).toEqual({ ok: false, code: 'network', retryAfterS: null });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(r)).not.toContain('api.telegram.org');
  });
  it('the same for the pairing source', async () => {
    const token = fakeBotToken();
    const src = createTelegramPairingSource({
      token,
      fetchImpl: async (url) => {
        throw new TypeError(`fetch failed for ${url}`);
      },
    });
    const r = await src.getUpdates({ offset: null, timeoutSec: 1 });
    expect(r).toEqual({ ok: false, code: 'network' });
    expect(JSON.stringify(r)).not.toContain(token);
  });
  it('a provider reply that echoes the token or the URL is not passed on', async () => {
    const token = fakeBotToken();
    const channel = createTelegramChannel({
      token,
      chatId: fakeChatId(),
      fetchImpl: async (url) =>
        json(400, { ok: false, error_code: 400, description: `bad request to ${url}` }),
    });
    const r = await channel.send('x');
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r).toMatchObject({ ok: false, code: 'bad_request' });
  });
  it('a timeout is a code too, and the request really is aborted', async () => {
    const token = fakeBotToken();
    let aborted = false;
    const channel = createTelegramChannel({
      token,
      chatId: fakeChatId(),
      timeoutMs: 20,
      fetchImpl: (_u, init) =>
        new Promise<Response>((_res, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException(`aborted ${_u}`, 'AbortError'));
          });
        }),
    });
    const r = await channel.send('x');
    expect(r).toEqual({ ok: false, code: 'timeout', retryAfterS: null });
    expect(aborted).toBe(true);
    expect(JSON.stringify(r)).not.toContain(token);
  });
});

describe('a timeout while the reply body is being read', () => {
  it('is a timeout (the message may have been delivered), not a bad reply', async () => {
    const token = fakeBotToken();
    const channel = createTelegramChannel({
      token,
      chatId: fakeChatId(),
      timeoutMs: 20,
      fetchImpl: async (_u, init) =>
        ({
          status: 200,
          json: () =>
            new Promise((_res, reject) =>
              init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
        }) as unknown as Response,
    });
    expect(await channel.send('x')).toEqual({ ok: false, code: 'timeout', retryAfterS: null });
  });
});

describe('getUpdates (pairing) replies', () => {
  const src = (res: (c: Call) => Response) => {
    const token = fakeBotToken();
    const s = stub(res);
    return { token, s, source: createTelegramPairingSource({ token, fetchImpl: s.fetch }) };
  };
  it('sends only the offset, the timeout and message updates, and parses what it needs', async () => {
    const { s, source } = src(() =>
      json(200, {
        ok: true,
        result: [
          {
            update_id: 5,
            message: {
              message_id: 1,
              date: 1,
              from: { id: 9, is_bot: false },
              chat: { id: 9, type: 'private', first_name: 'X' },
              text: 'hi',
            },
          },
          { update_id: 6 },
        ],
      }),
    );
    const r = await source.getUpdates({ offset: 5, timeoutSec: 20 });
    expect(r).toEqual({
      ok: true,
      updates: [
        { updateId: 5, chatId: 9, chatType: 'private', text: 'hi' },
        { updateId: 6, chatId: null, chatType: null, text: null },
      ],
    });
    expect(JSON.parse((s.calls[0] as Call).init.body as string)).toEqual({
      offset: 5,
      timeout: 20,
      allowed_updates: ['message'],
    });
  });
  it('omits the offset when there is none', async () => {
    const { s, source } = src(() => json(200, { ok: true, result: [] }));
    await source.getUpdates({ offset: null, timeoutSec: 0 });
    expect(JSON.parse((s.calls[0] as Call).init.body as string)).toEqual({
      timeout: 0,
      allowed_updates: ['message'],
    });
  });
  it('ONE malformed update makes the whole reply unverified (fail closed)', async () => {
    for (const bad of [
      [{ update_id: 'x' }],
      [{ update_id: 1, message: { chat: { id: 'abc', type: 'private' } } }],
      [{ update_id: 1, message: { chat: { type: 'private' } } }],
      [{ update_id: 1, message: { chat: { id: 1, type: 'private' }, text: 5 } }],
      [{ update_id: 1 }, 'junk'],
      [null],
    ]) {
      const { source } = src(() => json(200, { ok: true, result: bad }));
      expect(await source.getUpdates({ offset: null, timeoutSec: 0 }), JSON.stringify(bad)).toEqual(
        { ok: false, code: 'bad_response' },
      );
    }
  });
  it('result must be a list; ok must be true', async () => {
    for (const body of [{ ok: true, result: {} }, { ok: true }, { ok: false, result: [] }, {}]) {
      const { source } = src(() => json(200, body));
      expect(await source.getUpdates({ offset: null, timeoutSec: 0 })).toMatchObject({ ok: false });
    }
  });
  it('maps 409 (a webhook is set), 401 and 429', async () => {
    for (const [status, code] of [
      [409, 'conflict'],
      [401, 'unauthorized'],
      [429, 'rate_limited'],
    ] as const) {
      const { source } = src(() => json(status, { ok: false, error_code: status }));
      expect(await source.getUpdates({ offset: null, timeoutSec: 0 })).toEqual({ ok: false, code });
    }
  });
  it('waits longer than the long-poll time before giving up', async () => {
    const { source } = src(() => json(200, { ok: true, result: [] }));
    expect(await source.getUpdates({ offset: null, timeoutSec: 0 })).toEqual({
      ok: true,
      updates: [],
    });
  });
});

describe('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (validated lazily, like AUTH_SECRET)', () => {
  it('ready with a well-formed token and a private chat id', () => {
    const token = fakeBotToken();
    const chat = fakeChatId();
    expect(parseTelegramEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat })).toEqual({
      status: 'ready',
      token,
      chatId: chat,
    });
  });
  it('missing or blank means "not set up", not an error', () => {
    expect(parseTelegramEnv({}).status).toBe('not_configured');
    expect(parseTelegramEnv({ TELEGRAM_BOT_TOKEN: fakeBotToken() }).status).toBe('not_configured');
    expect(parseTelegramEnv({ TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: ' ' }).status).toBe(
      'not_configured',
    );
  });
  it('rejects placeholders, wrong shapes, and group (negative) chat ids', () => {
    const chat = fakeChatId();
    for (const token of [
      'replace-with-your-bot-token-from-botfather-see-docs',
      'abc',
      'x'.repeat(50),
      '123456789:short',
      `123456789:${'a'.repeat(40)} extra`,
    ]) {
      expect(
        parseTelegramEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat }).status,
        token,
      ).toBe('invalid');
    }
    for (const bad of ['-100123456789', 'abc', '12', '1.5', '12345678901234567890']) {
      expect(
        parseTelegramEnv({ TELEGRAM_BOT_TOKEN: fakeBotToken(), TELEGRAM_CHAT_ID: bad }).status,
        bad,
      ).toBe('invalid');
    }
  });
  it('never echoes a value in a message', () => {
    const e = parseTelegramEnv({
      TELEGRAM_BOT_TOKEN: '123456789:SUPERSECRETTOKENVALUE',
      TELEGRAM_CHAT_ID: '987654321',
    });
    expect(JSON.stringify(e)).not.toContain('SUPERSECRET');
    const f = parseTelegramEnv({
      TELEGRAM_BOT_TOKEN: fakeBotToken(),
      TELEGRAM_CHAT_ID: '-555SECRETCHAT',
    });
    expect(JSON.stringify(f)).not.toContain('SECRETCHAT');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_VERSION,
  buildRequestBody,
  createAnthropicClient,
  MESSAGES_URL,
} from '@/integrations/anthropic/client';
import type { AnalystRequest } from '@/integrations/anthropic/types';
import { fakeApiKey } from '../helpers/analyst';

const req: AnalystRequest = {
  model: 'claude-sonnet-5-5',
  system: 'SYSTEM',
  user: 'USER',
  maxOutputTokens: 4000,
  timeoutMs: 1000,
  effort: 'low',
};

interface Call {
  url: string;
  init: RequestInit;
}
function stubFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const okBody = (over: Record<string, unknown> = {}) => ({
  content: [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: '{"a":' },
    { type: 'text', text: '1}' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20 },
  ...over,
});

describe('the request (no tools, no retries, key only in a header)', () => {
  it('sends one POST to the fixed URL with the documented headers and body', async () => {
    const key = fakeApiKey();
    const s = stubFetch(() => json(200, okBody()));
    const r = await createAnthropicClient(key, s.fetch).complete(req);
    expect(r).toEqual({ ok: true, text: '{"a":1}', inputTokens: 100, outputTokens: 20 });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0] as Call;
    expect(call.url).toBe(MESSAGES_URL);
    expect(MESSAGES_URL).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(key);
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(call.init.method).toBe('POST');
    const body = JSON.parse(call.init.body as string);
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'USER' }],
      output_config: { effort: 'low' },
    });
  });

  it('the body can never carry tools, web search, files or MCP', () => {
    const body = buildRequestBody(req);
    for (const forbidden of [
      'tools',
      'tool_choice',
      'mcp_servers',
      'container',
      'files',
      'betas',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(body)).not.toMatch(/web_search|web_fetch|tool_use|function/);
  });

  it('leaves out effort for models that do not take it', () => {
    expect(buildRequestBody({ ...req, effort: null })).not.toHaveProperty('output_config');
  });

  it('does not put the key in the body', () => {
    const key = fakeApiKey();
    expect(JSON.stringify(buildRequestBody(req))).not.toContain(key);
  });

  it('does not retry on failure: exactly one call', async () => {
    const s = stubFetch(() =>
      json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }),
    );
    const r = await createAnthropicClient(fakeApiKey(), s.fetch).complete(req);
    expect(r.ok).toBe(false);
    expect(s.calls).toHaveLength(1);
  });
});

describe('answers and failures', () => {
  const run = (respond: () => Response | Promise<Response>) =>
    createAnthropicClient(fakeApiKey(), stubFetch(respond).fetch).complete(req);

  it('adds cache tokens to the input count', async () => {
    const r = await run(() =>
      json(
        200,
        okBody({
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
          },
        }),
      ),
    );
    expect(r).toMatchObject({ ok: true, inputTokens: 15, outputTokens: 5 });
  });

  it('max_tokens is a failure that is still billed (tokens kept)', async () => {
    const r = await run(() => json(200, okBody({ stop_reason: 'max_tokens' })));
    expect(r).toMatchObject({ ok: false, reason: 'truncated', inputTokens: 100, outputTokens: 20 });
  });

  it('refusal is checked before content is read', async () => {
    const r = await run(() => json(200, okBody({ stop_reason: 'refusal', content: [] })));
    expect(r).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('tool_use (which can never be asked for) is an error, never executed', async () => {
    const r = await run(() => json(200, okBody({ stop_reason: 'tool_use' })));
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
  });

  it('HTTP errors give a fixed description with the error type and request id, never provider text or the key', async () => {
    const key = fakeApiKey();
    const s = stubFetch(() =>
      json(
        400,
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: `echo ${key} and PROVIDER FREE TEXT` },
        },
        { 'request-id': 'req_abc123' },
      ),
    );
    const r = await createAnthropicClient(key, s.fetch).complete(req);
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).toContain('HTTP 400 invalid_request_error');
    expect(text).toContain('spend limit');
    expect(text).toContain('req_abc123');
    expect(text).not.toContain(key);
    expect(text).not.toContain('PROVIDER FREE TEXT');
  });

  it('ignores an unsafe request id or error type', async () => {
    const r = await run(() =>
      json(500, { error: { type: '<script>' } }, { 'request-id': 'bad id with spaces' }),
    );
    expect(JSON.stringify(r)).not.toContain('<script>');
    expect(JSON.stringify(r)).not.toContain('bad id');
  });

  it('a network error is a plain failure without the error text', async () => {
    const key = fakeApiKey();
    const r = await createAnthropicClient(key, async () => {
      throw new Error(`connect failed with ${key}`);
    }).complete(req);
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a malformed 200 reply is an error', async () => {
    expect(await run(() => json(200, { nope: true }))).toMatchObject({
      ok: false,
      reason: 'api_error',
    });
    expect(await run(() => new Response('not json', { status: 200 }))).toMatchObject({ ok: false });
  });

  it('times out when the provider does not answer in time', async () => {
    const client = createAnthropicClient(
      fakeApiKey(),
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const r = await client.complete({ ...req, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

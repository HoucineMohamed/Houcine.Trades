import { describe, expect, it, vi } from 'vitest';
import { createAnthropicClient } from '@/integrations/anthropic/client';
import { parseAnalystEnv } from '@/integrations/anthropic/env';
import { runAnalyst, type AnalystRuntime } from '@/analyst/service';
import { buildTutorPrompt } from '@/domain/analyst';
import { riskDb } from '../helpers/risk';
import { enableAnalyst, fakeApiKey, tutorJson } from '../helpers/analyst';

const NOW = new Date('2026-03-10T12:00:00.000Z');

/** Every byte of the database, as text, to search for a secret. */
const dump = (db: ReturnType<typeof riskDb>): string =>
  Buffer.from(db.$client.serialize()).toString('latin1');

function runtimeWith(key: string, respond: () => Response): AnalystRuntime {
  const model = parseAnalystEnv({ ANTHROPIC_API_KEY: key });
  if (model.status !== 'ready') throw new Error('test key rejected');
  return {
    status: 'ready',
    model: model.model,
    client: createAnthropicClient(model.apiKey, async () => respond()),
  };
}
const built = () =>
  buildTutorPrompt({ question: 'What is expectancy?', currency: null, metrics: [] });
const okResponse = () =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text: tutorJson() }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200 },
  );

describe('the API key never leaks', () => {
  it('is not in the request body, the outcome, the stored records, the log, or the console (success)', async () => {
    const key = fakeApiKey();
    const db = riskDb();
    enableAnalyst(db, NOW);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const prompt = built();
    const outcome = await runAnalyst(
      db,
      runtimeWith(key, okResponse),
      prompt,
      { accountId: null, subject: 'q' },
      NOW,
    );
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(key);
    expect(prompt.system + prompt.user).not.toContain(key);
    expect(dump(db)).not.toContain(key);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('is not in any error, even when the provider echoes the key back', async () => {
    const key = fakeApiKey();
    const db = riskDb();
    enableAnalyst(db, NOW);
    const echo = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: `bad key ${key}` },
        }),
        { status: 401, headers: { 'request-id': 'req_1' } },
      );
    const outcome = await runAnalyst(
      db,
      runtimeWith(key, echo),
      built(),
      { accountId: null, subject: 'q' },
      NOW,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'api_error' });
    expect(JSON.stringify(outcome)).not.toContain(key);
    expect(dump(db)).not.toContain(key);
  });

  it('is not in a thrown network error either', async () => {
    const key = fakeApiKey();
    const db = riskDb();
    enableAnalyst(db, NOW);
    const model = parseAnalystEnv({ ANTHROPIC_API_KEY: key });
    if (model.status !== 'ready') throw new Error('rejected');
    const runtime: AnalystRuntime = {
      status: 'ready',
      model: model.model,
      client: createAnthropicClient(model.apiKey, async () => {
        throw new Error(`socket hang up (headers: x-api-key ${key})`);
      }),
    };
    const outcome = await runAnalyst(db, runtime, built(), { accountId: null, subject: 'q' }, NOW);
    expect(JSON.stringify(outcome)).not.toContain(key);
    expect(dump(db)).not.toContain(key);
  });

  it('a key typed into a note is masked before it is sent or stored', async () => {
    const key = fakeApiKey();
    const db = riskDb();
    enableAnalyst(db, NOW);
    const prompt = buildTutorPrompt({
      question: `my key is ${key}, what is risk?`,
      currency: null,
      metrics: [],
    });
    expect(prompt.user).not.toContain(key);
    const outcome = await runAnalyst(
      db,
      runtimeWith(fakeApiKey(), okResponse),
      prompt,
      { accountId: null, subject: 'q' },
      NOW,
    );
    expect(outcome.ok).toBe(true);
    expect(dump(db)).not.toContain(key);
  });
});

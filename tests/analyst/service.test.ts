import { describe, expect, it, vi } from 'vitest';
import { buildTutorPrompt } from '@/domain/analyst';
import { runAnalyst } from '@/analyst/service';
import {
  getAiSettings,
  getUsageTotals,
  listRecentUsage,
  listReviews,
  setAiConsent,
} from '@/data/analyst';
import { riskDb } from '../helpers/risk';
import {
  enableAnalyst,
  failReply,
  fakeApiKey,
  fakeClient,
  okReply,
  readyRuntime,
  setCaps,
  type Reply,
  tutorJson,
} from '../helpers/analyst';
import { freshAuthForTests } from '../helpers/auth';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const built = (q = 'What is expectancy?') =>
  buildTutorPrompt({
    question: q,
    currency: 'USDT',
    metrics: [{ key: 'expectancy (R)', value: '0.2000', figure: true }],
  });
const meta = { accountId: null, subject: 'What is expectancy?' };

function ready(reply: Reply = okReply(tutorJson())) {
  const db = riskDb();
  enableAnalyst(db, NOW);
  const client = fakeClient(reply);
  return { db, client, runtime: readyRuntime(client) };
}

describe('the happy path', () => {
  it('sends one request, validates the reply, logs the usage and stores the review', async () => {
    const { db, client, runtime } = ready();
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: true, fromStore: false });
    expect(client.requests).toHaveLength(1);
    const usage = listRecentUsage(db);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      feature: 'tutor',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: '0.007000', // 1000 x $2/M + 500 x $10/M
      status: 'ok',
    });
    expect(listReviews(db)).toHaveLength(1);
  });

  it('sends exactly what the prompt builder made, with the safe request limits and effort', async () => {
    const { db, client, runtime } = ready();
    const b = built();
    await runAnalyst(db, runtime, b, meta, NOW);
    expect(client.requests[0]).toEqual({
      model: 'claude-sonnet-5-5',
      system: b.system,
      user: b.user,
      maxOutputTokens: 4000,
      timeoutMs: 60_000,
      effort: 'low',
    });
  });

  it('does not send effort to a model that cannot take it', async () => {
    const db = riskDb();
    enableAnalyst(db, NOW);
    const client = fakeClient(okReply(tutorJson()));
    await runAnalyst(db, readyRuntime(client, 'claude-haiku-4-5'), built(), meta, NOW);
    expect(client.requests[0]?.effort).toBeNull();
  });

  it('identical input is answered from the store: nothing is sent and nothing is paid twice', async () => {
    const { db, client, runtime } = ready();
    await runAnalyst(db, runtime, built(), meta, NOW);
    const again = await runAnalyst(db, runtime, built(), meta, new Date(NOW.getTime() + 1000));
    expect(again).toMatchObject({ ok: true, fromStore: true });
    expect(client.requests).toHaveLength(1);
    expect(listRecentUsage(db)).toHaveLength(1);
  });

  it('different input is a new request', async () => {
    const { db, client, runtime } = ready();
    await runAnalyst(db, runtime, built('A?'), meta, NOW);
    await runAnalyst(db, runtime, built('B?'), meta, NOW);
    expect(client.requests).toHaveLength(2);
  });
});

describe('gates that stop a request BEFORE anything is sent', () => {
  it('no key / invalid key / unknown model: unavailable, with the plain message', async () => {
    const db = riskDb();
    enableAnalyst(db, NOW);
    const r = await runAnalyst(
      db,
      { status: 'unavailable', message: 'No API key is set.' },
      built(),
      meta,
      NOW,
    );
    expect(r).toEqual({ ok: false, code: 'unavailable', message: 'No API key is set.' });
    expect(listRecentUsage(db)).toEqual([]);
  });

  it('consent OFF (the default): nothing is sent', async () => {
    const db = riskDb();
    const client = fakeClient(okReply(tutorJson()));
    const r = await runAnalyst(db, readyRuntime(client), built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'consent_off' });
    expect(client.requests).toHaveLength(0);
  });

  it('consent switched back OFF: nothing is sent', async () => {
    const { db, client, runtime } = ready();
    setAiConsent(db, false, null, NOW);
    expect(await runAnalyst(db, runtime, built(), meta, NOW)).toMatchObject({
      code: 'consent_off',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('corrupt settings: nothing is sent', async () => {
    const { db, client, runtime } = ready();
    db.$client.prepare("UPDATE ai_settings SET caps_json = '{}'").run();
    expect(await runAnalyst(db, runtime, built(), meta, NOW)).toMatchObject({
      code: 'settings_corrupt',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('an unpriced model: nothing is sent', async () => {
    const db = riskDb();
    enableAnalyst(db, NOW);
    const client = fakeClient(okReply(tutorJson()));
    const r = await runAnalyst(db, readyRuntime(client, 'not-a-priced-model'), built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'model_unpriced' });
    expect(client.requests).toHaveLength(0);
  });

  it('an unreadable usage log: nothing is sent (fail closed)', async () => {
    const { db, client, runtime } = ready();
    db.$client.exec('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    expect(await runAnalyst(db, runtime, built(), meta, NOW)).toMatchObject({
      code: 'usage_unreadable',
    });
    expect(client.requests).toHaveLength(0);
  });
});

describe('spend caps stop requests', () => {
  it('daily cap: the call after the limit is refused, and it resets the next UTC day', async () => {
    const { db, client, runtime } = ready();
    setCaps(db, { dailyCalls: 2 }, NOW);
    // dailyCalls 20 -> 2 is a tightening: applies at once
    for (const q of ['1?', '2?']) {
      expect(await runAnalyst(db, runtime, built(q), meta, NOW)).toMatchObject({ ok: true });
    }
    const third = await runAnalyst(db, runtime, built('3?'), meta, NOW);
    expect(third).toMatchObject({ ok: false, code: 'cap_reached' });
    expect(client.requests).toHaveLength(2);
    const tomorrow = new Date('2026-03-11T00:00:00.000Z');
    expect(await runAnalyst(db, runtime, built('3?'), meta, tomorrow)).toMatchObject({ ok: true });
  });

  it('monthly call cap', async () => {
    const { db, client, runtime } = ready();
    setCaps(db, { monthlyCalls: 1 }, NOW);
    await runAnalyst(db, runtime, built('1?'), meta, NOW);
    const r = await runAnalyst(
      db,
      runtime,
      built('2?'),
      meta,
      new Date('2026-03-20T00:00:00.000Z'),
    );
    expect(r).toMatchObject({ ok: false, code: 'cap_reached' });
    expect(client.requests).toHaveLength(1);
    expect(
      await runAnalyst(db, runtime, built('2?'), meta, new Date('2026-04-01T00:00:00.000Z')),
    ).toMatchObject({ ok: true });
  });

  it('monthly cost cap: the worst case of the NEXT request must fit', async () => {
    const { db, client, runtime } = ready();
    setCaps(db, { monthlyCostUsd: '0.045' }, NOW);
    // worst case of one tutor call is about 0.042 USD (4000 output tokens x $10/M + input)
    expect(await runAnalyst(db, runtime, built('1?'), meta, NOW)).toMatchObject({ ok: true }); // spends 0.007
    const r = await runAnalyst(db, runtime, built('2?'), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'cap_reached' });
    expect(client.requests).toHaveLength(1);
  });

  it('a LOOSENED cap does not apply until 24 hours have passed', async () => {
    const { db, client, runtime } = ready();
    setCaps(db, { dailyCalls: 1 }, NOW);
    await runAnalyst(db, runtime, built('1?'), meta, NOW);
    setCaps(db, { dailyCalls: 50 }, NOW); // loosening: pending
    expect(await runAnalyst(db, runtime, built('2?'), meta, NOW)).toMatchObject({
      code: 'cap_reached',
    });
    const later = new Date(NOW.getTime() + 24 * 3600_000 - 1);
    // still the same UTC day? no: use a time inside the same day by using caps check on 03-10 only
    expect(getAiSettings(db, later).effective?.dailyCalls).toBe(1);
    expect(client.requests).toHaveLength(1);
  });

  it('failed calls count too (a timeout counts its worst case)', async () => {
    const { db, runtime, client } = ready(failReply('timeout'));
    setCaps(db, { dailyCalls: 1 }, NOW);
    expect(await runAnalyst(db, runtime, built('1?'), meta, NOW)).toMatchObject({
      code: 'timeout',
    });
    expect(await runAnalyst(db, runtime, built('2?'), meta, NOW)).toMatchObject({
      code: 'cap_reached',
    });
    expect(client.requests).toHaveLength(1);
    const totals = getUsageTotals(db, NOW);
    expect(totals.callsToday).toBe(1);
    expect(Number(totals.costThisMonthUsd)).toBeGreaterThan(0);
  });

  it('two requests at the same moment cannot both slip under a cap of 1', async () => {
    const { db, runtime, client } = ready();
    setCaps(db, { dailyCalls: 1 }, NOW);
    const results = await Promise.all([
      runAnalyst(db, runtime, built('a?'), meta, NOW),
      runAnalyst(db, runtime, built('b?'), meta, NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(client.requests).toHaveLength(1);
  });
});

describe('failures are plain, logged, and never retried', () => {
  it.each([
    ['api_error', 'api_error'],
    ['timeout', 'timeout'],
    ['refused', 'refused'],
  ] as const)('%s', async (reason, code) => {
    const { db, runtime, client } = ready(failReply(reason));
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code });
    expect(client.requests).toHaveLength(1); // no retry
    expect(listRecentUsage(db)[0]).toMatchObject({ status: reason });
    expect(listReviews(db)).toEqual([]);
  });

  it('an HTTP-style api_error costs nothing; a truncated reply is billed from its tokens', async () => {
    const a = ready(failReply('api_error'));
    await runAnalyst(a.db, a.runtime, built(), meta, NOW);
    expect(listRecentUsage(a.db)[0]?.estimatedCostUsd).toBe('0.000000');
    const t = ready(failReply('truncated', { in: 1000, out: 4000 }));
    const r = await runAnalyst(t.db, t.runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'truncated' });
    expect(listRecentUsage(t.db)[0]).toMatchObject({
      status: 'truncated',
      estimatedCostUsd: '0.042000',
      outputTokens: 4000,
    });
  });

  it('an invalid reply is not shown or stored as a review, but its cost is logged', async () => {
    const { db, runtime } = ready(okReply('Sure, here is my advice: buy now'));
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'invalid_output' });
    expect(listReviews(db)).toEqual([]);
    expect(listRecentUsage(db)[0]).toMatchObject({
      status: 'invalid_output',
      estimatedCostUsd: '0.007000',
    });
  });

  it('a client that throws is a plain api_error', async () => {
    const { db, runtime } = ready(new Error(`boom ${fakeApiKey()}`));
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'api_error' });
    expect(JSON.stringify(r)).not.toContain('boom');
  });

  it('if the review cannot be saved, the spend is STILL counted (and the answer is not shown)', async () => {
    const { db, runtime } = ready();
    db.$client.exec(
      "CREATE TRIGGER block_reviews BEFORE INSERT ON ai_reviews BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'storage_error' });
    expect(listRecentUsage(db)).toHaveLength(1);
    expect(getUsageTotals(db, NOW).callsToday).toBe(1);
  });

  it('if the usage cannot be written, the answer is NOT shown', async () => {
    const { db, runtime } = ready();
    db.$client.exec(
      "CREATE TRIGGER block_usage BEFORE INSERT ON ai_usage BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    expect(r).toMatchObject({ ok: false, code: 'storage_error' });
    expect(listReviews(db)).toEqual([]);
  });

  it('a billed reply that cannot be read counts the worst case, but an HTTP error counts nothing', async () => {
    const unknown = ready({
      ok: false,
      reason: 'api_error',
      detail: 'x',
      billing: 'unknown',
      inputTokens: null,
      outputTokens: null,
    });
    await runAnalyst(unknown.db, unknown.runtime, built(), meta, NOW);
    expect(Number(listRecentUsage(unknown.db)[0]?.estimatedCostUsd)).toBeGreaterThan(0.03);
    const http = ready(failReply('api_error'));
    await runAnalyst(http.db, http.runtime, built(), meta, NOW);
    expect(listRecentUsage(http.db)[0]?.estimatedCostUsd).toBe('0.000000');
  });

  it('two identical requests at the same moment send ONE request (the second reads the stored answer)', async () => {
    const { db, runtime, client } = ready();
    const [a, b] = await Promise.all([
      runAnalyst(db, runtime, built('same?'), meta, NOW),
      runAnalyst(db, runtime, built('same?'), meta, NOW),
    ]);
    expect(client.requests).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.fromStore)).toHaveLength(1);
  });

  it('skips an unreadable stored answer and uses the newest readable one', async () => {
    const { db, runtime, client } = ready();
    const b = built('again?');
    await runAnalyst(db, runtime, b, meta, NOW);
    // an OLDER row with the same hash whose output no longer validates
    db.$client.exec('DROP TRIGGER ai_reviews_no_update');
    db.$client.prepare('UPDATE ai_reviews SET id = 50').run();
    db.$client
      .prepare(
        "INSERT INTO ai_reviews (id, kind, input_hash, output_json, checks_json, usage_id, model, created_at) SELECT 5, kind, input_hash, '{}', checks_json, usage_id, model, created_at FROM ai_reviews",
      )
      .run();
    const r = await runAnalyst(db, runtime, b, meta, NOW);
    expect(r).toMatchObject({ ok: true, fromStore: true, reviewId: 50 });
    expect(client.requests).toHaveLength(1);
  });

  it('if the stored answers cannot be read, nothing is sent', async () => {
    const { db, runtime, client } = ready();
    db.$client.exec('DROP TABLE ai_reviews');
    expect(await runAnalyst(db, runtime, built(), meta, NOW)).toMatchObject({
      code: 'storage_error',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('does not log anything to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const ok = ready();
    await runAnalyst(ok.db, ok.runtime, built(), meta, NOW);
    const bad = ready(failReply('api_error'));
    await runAnalyst(bad.db, bad.runtime, built(), meta, NOW);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('the checks stored with a review', () => {
  it('flags unverified figures and instruction wording but keeps the text', async () => {
    const { db, runtime } = ready(
      okReply(
        tutorJson({
          explanation: 'You should close the trade.',
          cited_figures: [
            { label: 'expectancy', value: '0.2000' },
            { label: 'made up', value: '77' },
          ],
        }),
      ),
    );
    const r = await runAnalyst(db, runtime, built(), meta, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(r.checks.flagged).toBe(true);
    expect(r.checks.verified.map((f) => f.value)).toEqual(['0.2000']);
    expect(r.checks.unverified.map((f) => f.value)).toEqual(['77']);
    expect(r.checks.instructionHits).toHaveLength(1);
    expect('explanation' in r.output && r.output.explanation).toBe('You should close the trade.');
  });

  it('records that the input was truncated', async () => {
    const { db, runtime } = ready();
    const long = buildTutorPrompt({ question: 'word '.repeat(2000), currency: null, metrics: [] });
    const r = await runAnalyst(db, runtime, long, meta, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(r.checks.truncated).toBe(true);
  });
});

describe('the freshness rule for the switch is not bypassed by the service', () => {
  it('a never-enabled database cannot send (default OFF) even with a valid runtime', async () => {
    const db = riskDb();
    expect(() => setAiConsent(db, true, null, NOW)).toThrow();
    const client = fakeClient(okReply(tutorJson()));
    expect(await runAnalyst(db, readyRuntime(client), built(), meta, NOW)).toMatchObject({
      code: 'consent_off',
    });
    void freshAuthForTests;
  });
});

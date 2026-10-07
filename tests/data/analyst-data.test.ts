import { describe, expect, it } from 'vitest';
import {
  AiDataError,
  getAiSettings,
  getReview,
  getUsageTotals,
  listReviews,
  recordUsage,
  saveReview,
  setAiConsent,
  updateAiCaps,
  type ReviewChecks,
} from '@/data/analyst';
import { listAuthEvents } from '@/data/auth';
import { StepUpRequiredError } from '@/domain/auth/stepup';
import { ValidationError } from '@/domain/errors';
import { AI_CAP_DEFAULTS, type TutorOutput } from '@/domain/analyst';
import { freshAuthForTests } from '../helpers/auth';
import { memoryDb } from '../helpers/db';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

function dbWithSession() {
  const db = memoryDb();
  db.$client
    .prepare(
      "INSERT INTO sessions (token_hash, created_at, last_seen_at) VALUES ('h', '2026-03-10T11:00:00.000Z', '2026-03-10T11:00:00.000Z')",
    )
    .run();
  return db;
}
const fresh = (now: Date = NOW) => freshAuthForTests(1, now);
const kinds = (db: ReturnType<typeof memoryDb>) => listAuthEvents(db).map((e) => e.kind);

describe('settings default to OFF with the default caps', () => {
  it('has no row at first: consent off, defaults in force', () => {
    const v = getAiSettings(memoryDb(), NOW);
    expect(v.consent).toBe(false);
    expect(v.effective).toEqual(AI_CAP_DEFAULTS);
    expect(v.problem).toBeNull();
  });
});

describe('the privacy switch', () => {
  it('turning ON needs a fresh code and is logged', () => {
    const db = dbWithSession();
    expect(() => setAiConsent(db, true, null, NOW)).toThrow(StepUpRequiredError);
    expect(getAiSettings(db, NOW).consent).toBe(false);
    expect(kinds(db)).toEqual([]);

    setAiConsent(db, true, fresh(), NOW);
    expect(getAiSettings(db, NOW).consent).toBe(true);
    expect(kinds(db)).toEqual(['ai_consent_on']);
  });

  it('an old proof (older than 5 minutes) is refused', () => {
    const db = dbWithSession();
    const old = freshAuthForTests(1, at('2026-03-10T11:50:00.000Z'));
    expect(() => setAiConsent(db, true, old, NOW)).toThrow(StepUpRequiredError);
  });

  it('turning OFF needs no code and is logged', () => {
    const db = dbWithSession();
    setAiConsent(db, true, fresh(), NOW);
    setAiConsent(db, false, null, NOW, { sessionId: 1 });
    expect(getAiSettings(db, NOW).consent).toBe(false);
    expect(kinds(db)).toEqual(['ai_consent_off', 'ai_consent_on']);
  });

  it('keeps the caps when the switch changes', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 10 }, null, NOW);
    setAiConsent(db, true, fresh(), NOW);
    expect(getAiSettings(db, NOW).effective?.dailyCalls).toBe(10);
  });
});

describe('caps: tighten now, loosen after 24 hours with a code', () => {
  it('a lower cap applies at once without a code, and is logged', () => {
    const db = dbWithSession();
    const r = updateAiCaps(db, { dailyCalls: 10, monthlyCostUsd: '2' }, null, NOW);
    expect(r.applied).toHaveLength(2);
    expect(getAiSettings(db, NOW).effective).toEqual({
      dailyCalls: 10,
      monthlyCalls: 200,
      monthlyCostUsd: '2',
    });
    expect(kinds(db)).toEqual(['ai_caps_changed']);
    expect(listAuthEvents(db)[0]?.detail).toBe('tightened');
  });

  it('a higher cap without a code is refused and changes nothing', () => {
    const db = dbWithSession();
    expect(() => updateAiCaps(db, { dailyCalls: 50 }, null, NOW)).toThrow(StepUpRequiredError);
    expect(getAiSettings(db, NOW).effective?.dailyCalls).toBe(20);
    expect(kinds(db)).toEqual([]);
  });

  it('a higher cap with a code waits 24 hours, then applies by itself', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    expect(getAiSettings(db, NOW).effective?.dailyCalls).toBe(20);
    expect(getAiSettings(db, NOW).pending.dailyCalls?.value).toBe(50);
    const almost = at('2026-03-11T11:59:59.000Z');
    expect(getAiSettings(db, almost).effective?.dailyCalls).toBe(20);
    const due = at('2026-03-11T12:00:00.000Z');
    expect(getAiSettings(db, due).effective?.dailyCalls).toBe(50);
  });

  it('a tightening after a pending loosening cancels it', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    updateAiCaps(db, { dailyCalls: 5 }, null, NOW);
    const v = getAiSettings(db, at('2026-03-20T00:00:00.000Z'));
    expect(v.effective?.dailyCalls).toBe(5);
    expect(v.pending).toEqual({});
  });

  it('rejects values above the hard ceilings, even with a code', () => {
    const db = dbWithSession();
    expect(() => updateAiCaps(db, { dailyCalls: 101 }, fresh(), NOW)).toThrow(ValidationError);
    expect(() => updateAiCaps(db, { monthlyCostUsd: '25.01' }, fresh(), NOW)).toThrow(
      ValidationError,
    );
    expect(() => updateAiCaps(db, { monthlyCalls: 1001 }, fresh(), NOW)).toThrow(ValidationError);
  });

  it('refuses to edit corrupt stored settings and reports the problem (fails closed)', () => {
    const db = dbWithSession();
    db.$client
      .prepare(
        "INSERT INTO ai_settings (id, consent, caps_json, updated_at) VALUES (1, 1, '{\"dailyCalls\":999999}', 't')",
      )
      .run();
    const v = getAiSettings(db, NOW);
    expect(v.problem).not.toBeNull();
    expect(v.effective).toBeNull();
    expect(() => updateAiCaps(db, { dailyCalls: 1 }, null, NOW)).toThrow(ValidationError);
  });

  it('a pending value that was tampered above a ceiling is reported, not trusted', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    db.$client
      .prepare(
        'UPDATE ai_settings SET pending_caps_json = \'{"dailyCalls":{"value":5000,"requestedAt":"a","effectiveAt":"2000-01-01T00:00:00.000Z"}}\'',
      )
      .run();
    const v = getAiSettings(db, NOW);
    expect(v.problem).not.toBeNull();
    expect(v.effective).toBeNull();
  });
});

describe('usage log', () => {
  const entry = (iso: string, cost: string) => ({
    at: at(iso),
    feature: 'tutor' as const,
    model: 'claude-sonnet-5-5',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: cost,
    status: 'ok' as const,
  });

  it('counts calls today and this month (UTC) and adds the estimated cost exactly', () => {
    const db = memoryDb();
    recordUsage(db, entry('2026-02-28T23:59:59.000Z', '9.000000')); // last month: ignored
    recordUsage(db, entry('2026-03-01T00:00:00.000Z', '0.100000'));
    recordUsage(db, entry('2026-03-09T23:59:59.000Z', '0.200000')); // yesterday
    recordUsage(db, entry('2026-03-10T00:00:00.000Z', '0.000001'));
    recordUsage(db, entry('2026-03-10T08:00:00.000Z', '0.000002'));
    expect(getUsageTotals(db, NOW)).toEqual({
      callsToday: 2,
      callsThisMonth: 4,
      costThisMonthUsd: '0.300003',
    });
  });

  it('an empty log is zero', () => {
    expect(getUsageTotals(memoryDb(), NOW)).toEqual({
      callsToday: 0,
      callsThisMonth: 0,
      costThisMonthUsd: '0',
    });
  });

  it('FAILS CLOSED when the log cannot be read or holds junk', () => {
    const db = memoryDb();
    db.$client.exec('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
    expect(() => getUsageTotals(db, NOW)).toThrow(AiDataError);

    const db2 = memoryDb();
    db2.$client
      .prepare(
        "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, estimated_cost_usd, status) VALUES ('2026-03-05T00:00:00.000Z', 'tutor', 'm', 1, 1, 'junk', 'ok')",
      )
      .run();
    expect(() => getUsageTotals(db2, NOW)).toThrow(AiDataError);
  });

  it('stores no prompt, answer or secret: the table has only the documented columns', () => {
    const cols = (
      memoryDb().$client.prepare('PRAGMA table_info(ai_usage)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      'id',
      'created_at',
      'feature',
      'model',
      'input_tokens',
      'output_tokens',
      'estimated_cost_usd',
      'status',
    ]);
  });
});

describe('stored reviews', () => {
  const output: TutorOutput = {
    explanation: 'Expectancy is the average result per trade.',
    example: 'Your expectancy is 0.2.',
    key_points: ['average'],
    cited_figures: [{ label: 'expectancy', value: '0.2' }],
  };
  const checks: ReviewChecks = {
    verified: [{ label: 'expectancy', value: '0.2' }],
    unverified: [],
    instructionHits: [],
    truncated: false,
    flagged: false,
  };

  function saved() {
    const db = memoryDb();
    const usageId = recordUsage(db, {
      at: NOW,
      feature: 'tutor',
      model: 'claude-sonnet-5-5',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: '0.000010',
      status: 'ok',
    });
    const id = saveReview(db, {
      at: NOW,
      kind: 'tutor',
      accountId: null,
      subject: 'What is expectancy?',
      inputHash: 'abc',
      output,
      checks,
      usageId,
      model: 'claude-sonnet-5-5',
    });
    return { db, id };
  }

  it('can be listed and read again, newest first', () => {
    const { db, id } = saved();
    const r = getReview(db, id);
    expect(r?.output).toEqual(output);
    expect(r?.checks).toEqual(checks);
    expect(listReviews(db).map((x) => x.id)).toEqual([id]);
  });

  it('re-validates on read: a tampered output is shown as unreadable (null), never guessed', () => {
    const { db, id } = saved();
    db.$client.exec('DROP TRIGGER ai_reviews_no_update');
    db.$client.prepare('UPDATE ai_reviews SET output_json = \'{"explanation": 1}\'').run();
    expect(getReview(db, id)?.output).toBeNull();
    db.$client.prepare("UPDATE ai_reviews SET checks_json = 'nope'").run();
    expect(getReview(db, id)?.checks).toBeNull();
  });
});

describe('a loosening that matured is never lost by a later save', () => {
  const AFTER = at('2026-03-11T12:00:01.000Z'); // 24 hours and 1 second later

  it('saving another cap keeps the matured value and does not restart its timer or ask for a code', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    // the owner now edits only the monthly cap (the form is prefilled with the effective 50)
    const r = updateAiCaps(db, { dailyCalls: 50, monthlyCalls: 100 }, null, AFTER);
    expect(r.deferred).toEqual([]);
    const v = getAiSettings(db, AFTER);
    expect(v.effective).toEqual({ dailyCalls: 50, monthlyCalls: 100, monthlyCostUsd: '5' });
    expect(v.pending).toEqual({});
  });

  it('toggling the privacy switch keeps it too', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    setAiConsent(db, true, fresh(AFTER), AFTER);
    expect(getAiSettings(db, AFTER).effective?.dailyCalls).toBe(50);
    setAiConsent(db, false, null, AFTER);
    expect(getAiSettings(db, AFTER).effective?.dailyCalls).toBe(50);
  });

  it('a still-waiting change stays waiting after a consent toggle', () => {
    const db = dbWithSession();
    updateAiCaps(db, { dailyCalls: 50 }, fresh(), NOW);
    setAiConsent(db, true, fresh(), NOW);
    expect(getAiSettings(db, NOW).pending.dailyCalls?.value).toBe(50);
  });
});

describe('corrupt settings are never silently rewritten', () => {
  function corrupt() {
    const db = dbWithSession();
    db.$client
      .prepare(
        "INSERT INTO ai_settings (id, consent, caps_json, updated_at) VALUES (1, 1, '{\"dailyCalls\":5}', 't')",
      )
      .run();
    return db;
  }
  it('the switch cannot be turned ON, and the stored caps are left as they are', () => {
    const db = corrupt();
    expect(() => setAiConsent(db, true, fresh(), NOW)).toThrow(ValidationError);
    const row = db.$client.prepare('SELECT caps_json FROM ai_settings').get() as {
      caps_json: string;
    };
    expect(row.caps_json).toBe('{"dailyCalls":5}');
  });
  it('the switch can still be turned OFF (touching only the switch) and it is logged as such', () => {
    const db = corrupt();
    setAiConsent(db, false, null, NOW);
    const row = db.$client.prepare('SELECT consent, caps_json FROM ai_settings').get() as {
      consent: number;
      caps_json: string;
    };
    expect(row).toEqual({ consent: 0, caps_json: '{"dailyCalls":5}' });
    expect(listAuthEvents(db)[0]?.detail).toBe('privacy_switch_settings_corrupt');
  });
});

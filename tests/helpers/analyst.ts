import { randomBytes } from 'node:crypto';
import type { Db } from '@/data/client';
import { setAiConsent, updateAiCaps } from '@/data/analyst';
import type { AnalystRuntime } from '@/analyst/service';
import type { AnalystClient, AnalystRequest, AnalystResult } from '@/integrations/anthropic/types';
import { freshAuthForTests } from './auth';

/** A fake key built at run time, so no key-looking literal lives in the repository. */
export const fakeApiKey = (): string => 'sk-' + 'ant-' + 'api03-' + randomBytes(24).toString('hex');

/**
 * The fake client every analyst test uses. It implements the SAME interface as the real client,
 * never touches the network, and records every request it receives.
 */
export interface FakeClient extends AnalystClient {
  requests: AnalystRequest[];
}

export type Reply = AnalystResult | ((req: AnalystRequest) => AnalystResult) | Error;

export function fakeClient(reply: Reply): FakeClient {
  const requests: AnalystRequest[] = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      const r = typeof reply === 'function' ? reply(req) : reply;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

export const okReply = (text: string, inputTokens = 1000, outputTokens = 500): AnalystResult => ({
  ok: true,
  text,
  inputTokens,
  outputTokens,
});

export const failReply = (
  reason: 'api_error' | 'timeout' | 'refused' | 'truncated',
  tokens: { in: number; out: number } | null = null,
): AnalystResult => ({
  ok: false,
  reason,
  detail: 'test failure',
  inputTokens: tokens?.in ?? null,
  outputTokens: tokens?.out ?? null,
});

export const planJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    explanation: 'The plan risks a small part of the account.',
    questions: ['Why this stop?'],
    conflicts: [],
    cited_figures: [],
    ...over,
  });

export const weeklyJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    summary: 'A small sample.',
    patterns: [],
    mistakes: [],
    rule_breaking: [],
    data_limits: ['The sample is small.'],
    questions: [],
    cited_figures: [],
    ...over,
  });

export const tutorJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    explanation: 'Expectancy is the average result per trade.',
    example: 'No metrics yet.',
    key_points: [],
    cited_figures: [],
    ...over,
  });

export const readyRuntime = (
  client: AnalystClient,
  model = 'claude-sonnet-5-5',
): AnalystRuntime => ({
  status: 'ready',
  client,
  model,
});

/** A session row (so step-up events can reference it), and the privacy switch turned ON. */
export function enableAnalyst(db: Db, now: Date = new Date()): void {
  db.$client
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, token_hash, created_at, last_seen_at) VALUES (1, 'test-hash', ?, ?)",
    )
    .run(now.toISOString(), now.toISOString());
  setAiConsent(db, true, freshAuthForTests(1, now), now);
}

export function setCaps(db: Db, caps: Record<string, unknown>, now: Date = new Date()): void {
  updateAiCaps(db, caps, freshAuthForTests(1, now), now);
}

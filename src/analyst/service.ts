import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AiDataError,
  getAiSettings,
  getReview,
  getUsageTotals,
  recordUsage,
  saveReview,
  type ReviewChecks,
  type StoredReview,
} from '@/data/analyst';
import type { Db } from '@/data/client';
import { aiReviews } from '@/data/schema';
import {
  checkCaps,
  checkOutput,
  estimateCostUsd,
  parseAnalystOutput,
  PRICE_TABLE,
  REQUEST_LIMITS,
  type AiUsageStatus,
  type AnalystOutput,
  type BuiltPrompt,
} from '@/domain/analyst';
import type { AnalystClient } from '@/integrations/anthropic/types';

/**
 * Runs one analyst request. EVERY gate is checked before anything leaves the computer, and each
 * one FAILS CLOSED with a plain message (the rest of the app is unaffected):
 *
 *   1. a usable key and a priced model        2. settings readable
 *   3. the privacy switch is ON               4. a stored answer for identical input (free)
 *   5. the model has a price                  6. the usage log is readable
 *   7. daily / monthly / cost caps allow it   8. ONE request at a time (so caps cannot be raced)
 *
 * Then: ONE request (no retry), the reply is validated, and the usage row (and review) are
 * written in one transaction. Nothing here logs. Only fixed messages are returned.
 */

export type AnalystRuntime =
  | { status: 'ready'; client: AnalystClient; model: string }
  | { status: 'unavailable'; message: string };

export interface RunMeta {
  accountId: number | null;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  currency?: string | null;
  /** The plan in words or the scrubbed question (stored with the review). */
  subject: string;
}

export type RefusalCode =
  | 'unavailable'
  | 'consent_off'
  | 'settings_corrupt'
  | 'usage_unreadable'
  | 'model_unpriced'
  | 'cap_reached'
  | 'api_error'
  | 'timeout'
  | 'refused'
  | 'truncated'
  | 'invalid_output'
  | 'storage_error';

export type AnalystOutcome =
  | {
      ok: true;
      reviewId: number;
      output: AnalystOutput;
      checks: ReviewChecks;
      /** True when an earlier stored answer for identical input was returned (nothing was sent). */
      fromStore: boolean;
      createdAt: string;
    }
  | { ok: false; code: RefusalCode; message: string };

const refuse = (code: RefusalCode, message: string): AnalystOutcome => ({
  ok: false,
  code,
  message,
});

export const inputHash = (model: string, built: BuiltPrompt): string =>
  createHash('sha256')
    .update(JSON.stringify([model, built.system, built.user]))
    .digest('hex');

// One request at a time: the cap check and the usage write cannot be raced by two requests.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const FAILURE_MESSAGES = {
  api_error: 'The AI service could not answer just now.',
  timeout: 'The AI service did not answer in time. Nothing was retried.',
  refused: 'The AI service declined to answer this one.',
  truncated: 'The answer was cut off at the size limit, so it was not used.',
} as const;

function fromStored(r: StoredReview): AnalystOutcome | null {
  if (!r.output || !r.checks) return null;
  return {
    ok: true,
    reviewId: r.id,
    output: r.output,
    checks: r.checks,
    fromStore: true,
    createdAt: r.createdAt,
  };
}

export async function runAnalyst(
  db: Db,
  runtime: AnalystRuntime,
  built: BuiltPrompt,
  meta: RunMeta,
  now: Date = new Date(),
): Promise<AnalystOutcome> {
  if (runtime.status !== 'ready') return refuse('unavailable', runtime.message);

  const settings = getAiSettings(db, now);
  if (settings.problem !== null || settings.effective === null) {
    return refuse(
      'settings_corrupt',
      'The analyst settings could not be read, so nothing is sent. Check the analyst page.',
    );
  }
  if (!settings.consent) {
    return refuse(
      'consent_off',
      'The privacy switch "Send journal data to the AI" is off, so nothing is sent. Turn it on at the analyst page.',
    );
  }
  const caps = settings.effective;

  const model = runtime.model;
  const price = PRICE_TABLE[model];
  if (!price) {
    return refuse(
      'model_unpriced',
      'The model has no price in the price table, so nothing is sent.',
    );
  }

  const hash = inputHash(model, built);
  try {
    const existing = db
      .select({ id: aiReviews.id })
      .from(aiReviews)
      .where(and(eq(aiReviews.kind, built.kind), eq(aiReviews.inputHash, hash)))
      .limit(1)
      .get();
    const stored = existing ? getReview(db, existing.id) : null;
    const outcome = stored ? fromStored(stored) : null;
    if (outcome) return outcome;
  } catch {
    return refuse('storage_error', 'The stored answers could not be read, so nothing is sent.');
  }

  return exclusive(async () => {
    let totals;
    try {
      totals = getUsageTotals(db, now);
    } catch (error) {
      if (error instanceof AiDataError) {
        return refuse('usage_unreadable', 'The usage log could not be read, so nothing is sent.');
      }
      throw error;
    }

    // Worst case for THIS request: one token per 2 characters in, the full answer size out.
    const inputTokensWorst = Math.ceil(
      (built.system.length + built.user.length) / REQUEST_LIMITS.charsPerTokenForProjection,
    );
    const projected = estimateCostUsd(model, inputTokensWorst, REQUEST_LIMITS.maxOutputTokens);
    if (projected === null) {
      return refuse('model_unpriced', 'The cost could not be estimated, so nothing is sent.');
    }
    const check = checkCaps(caps, totals, projected, now);
    if (!check.allowed) return refuse('cap_reached', check.message);

    // ---- the one request (no retry) -------------------------------------------------------
    let result;
    try {
      result = await runtime.client.complete({
        model,
        system: built.system,
        user: built.user,
        maxOutputTokens: REQUEST_LIMITS.maxOutputTokens,
        timeoutMs: REQUEST_LIMITS.timeoutMs,
        effort: price.supportsEffort ? 'low' : null,
      });
    } catch {
      result = {
        ok: false as const,
        reason: 'api_error' as const,
        detail: 'unexpected failure',
        inputTokens: null,
        outputTokens: null,
      };
    }

    // ---- decide the final status BEFORE writing (the usage log is append-only) --------------
    let status: AiUsageStatus;
    let inputTokens = 0;
    let outputTokens = 0;
    let cost: string;
    let output: AnalystOutput | null = null;
    if (result.ok) {
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      const parsed = parseAnalystOutput(built.kind, result.text);
      if (parsed.ok) {
        status = 'ok';
        output = parsed.output;
      } else status = 'invalid_output';
      cost = estimateCostUsd(model, inputTokens, outputTokens) ?? projected;
    } else {
      status = result.reason;
      if (result.inputTokens !== null && result.outputTokens !== null) {
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        cost = estimateCostUsd(model, inputTokens, outputTokens) ?? projected;
      } else if (result.reason === 'timeout') {
        cost = projected; // the request may still have been billed: count the worst case
      } else {
        cost = '0.000000'; // refused before any work was done (an HTTP error)
      }
    }

    const checks: ReviewChecks | null = output
      ? (() => {
          const c = checkOutput(output, built.allowedFigures);
          return {
            verified: c.figures.verified,
            unverified: c.figures.unverified,
            instructionHits: c.instructionHits,
            truncated: built.truncated,
            flagged: c.flagged,
          };
        })()
      : null;

    try {
      const saved = db.transaction((tx) => {
        const usageId = recordUsage(tx, {
          at: now,
          feature: built.kind,
          model,
          inputTokens,
          outputTokens,
          estimatedCostUsd: cost,
          status,
        });
        if (!output || !checks) return null;
        const reviewId = saveReview(tx, {
          at: now,
          kind: built.kind,
          accountId: meta.accountId,
          rangeFrom: meta.rangeFrom ?? null,
          rangeTo: meta.rangeTo ?? null,
          currency: meta.currency ?? null,
          subject: meta.subject,
          inputHash: hash,
          output,
          checks,
          usageId,
          model,
        });
        return reviewId;
      });
      if (saved !== null && output && checks) {
        return {
          ok: true,
          reviewId: saved,
          output,
          checks,
          fromStore: false,
          createdAt: now.toISOString(),
        };
      }
    } catch {
      return refuse(
        'storage_error',
        'The answer could not be saved, so it is not shown. The request may still have been counted by the provider.',
      );
    }

    if (status === 'invalid_output') {
      return refuse(
        'invalid_output',
        'The reply was not in the expected form, so it was not used.',
      );
    }
    if (!result.ok) return refuse(result.reason, FAILURE_MESSAGES[result.reason]);
    return refuse('api_error', FAILURE_MESSAGES.api_error);
  });
}

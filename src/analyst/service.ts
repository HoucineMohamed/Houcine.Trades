import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
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
  isPricedModel,
  parseAnalystOutput,
  PRICE_TABLE,
  REQUEST_LIMITS,
  type AiUsageStatus,
  type AnalystOutput,
  type BuiltPrompt,
} from '@/domain/analyst';
import type { AnalystClient, AnalystResult } from '@/integrations/anthropic/types';

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
// Kept on globalThis so that separately bundled route/action copies of this file share ONE queue.
const globalForQueue = globalThis as unknown as { __houcineAnalystQueue?: Promise<unknown> };
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalForQueue.__houcineAnalystQueue ?? Promise.resolve();
  const run = previous.then(fn, fn);
  globalForQueue.__houcineAnalystQueue = run.catch(() => undefined);
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
  const price = isPricedModel(model) ? PRICE_TABLE[model] : undefined;
  if (!price) {
    return refuse(
      'model_unpriced',
      'The model has no price in the price table, so nothing is sent.',
    );
  }

  const hash = inputHash(model, built);
  // A stored answer for identical input is free. Looked up again inside the lock below, so two
  // identical requests at the same moment cannot both be sent (and paid for).
  const lookup = (): AnalystOutcome | null => {
    const rows = db
      .select({ id: aiReviews.id })
      .from(aiReviews)
      .where(and(eq(aiReviews.kind, built.kind), eq(aiReviews.inputHash, hash)))
      .orderBy(desc(aiReviews.id))
      .all();
    for (const row of rows) {
      const stored = getReview(db, row.id);
      const outcome = stored ? fromStored(stored) : null;
      if (outcome) return outcome; // the newest READABLE answer
    }
    return null;
  };
  try {
    const hit = lookup();
    if (hit) return hit;
  } catch {
    return refuse('storage_error', 'The stored answers could not be read, so nothing is sent.');
  }

  return exclusive(async () => {
    try {
      const hit = lookup();
      if (hit) return hit;
    } catch {
      return refuse('storage_error', 'The stored answers could not be read, so nothing is sent.');
    }
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
    let result: AnalystResult;
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
        ok: false,
        reason: 'api_error',
        detail: 'unexpected failure',
        billing: 'unknown',
        inputTokens: null,
        outputTokens: null,
      };
    }

    // ---- from here on the request MAY be billed: whatever happens, it is counted -----------
    let status: AiUsageStatus = 'api_error';
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = projected; // the worst case, unless something more exact is known below
    let output: AnalystOutput | null = null;
    let checks: ReviewChecks | null = null;
    try {
      if (result.ok) {
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        cost = estimateCostUsd(model, inputTokens, outputTokens) ?? projected;
        const parsed = parseAnalystOutput(built.kind, result.text);
        if (parsed.ok) {
          status = 'ok';
          output = parsed.output;
          const c = checkOutput(output, built.allowedFigures);
          checks = {
            verified: c.figures.verified,
            unverified: c.figures.unverified,
            instructionHits: c.instructionHits,
            truncated: built.truncated,
            flagged: c.flagged,
          };
        } else status = 'invalid_output';
      } else {
        status = result.reason;
        if (result.inputTokens !== null && result.outputTokens !== null) {
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          cost = estimateCostUsd(model, inputTokens, outputTokens) ?? projected;
        } else if (result.billing === 'none') {
          cost = '0.000000'; // the provider answered with an HTTP error: nothing was generated
        }
      }
    } catch {
      // an unexpected problem while checking the reply: keep the worst-case cost, show nothing
      status = 'api_error';
      output = null;
      checks = null;
    }

    // The usage row is committed ON ITS OWN first, so a problem saving the review can never hide
    // the spend from the caps. If even this fails, nothing is shown.
    let usageId: number;
    try {
      usageId = recordUsage(db, {
        at: now,
        feature: built.kind,
        model,
        inputTokens,
        outputTokens,
        estimatedCostUsd: cost,
        status,
      });
    } catch {
      return refuse(
        'storage_error',
        'The request was sent but its usage could not be recorded, so the answer is not shown. Check the usage in the Anthropic console.',
      );
    }

    if (output && checks) {
      try {
        const reviewId = saveReview(db, {
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
        return {
          ok: true,
          reviewId,
          output,
          checks,
          fromStore: false,
          createdAt: now.toISOString(),
        };
      } catch {
        return refuse(
          'storage_error',
          'The answer was received and counted, but it could not be saved, so it is not shown.',
        );
      }
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

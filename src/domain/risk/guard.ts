import { ValidationError } from '../errors';
import type { Verdict } from './types';

/**
 * Guards for the dangerous actions.
 *
 * REAL ORDER EXECUTION (a later module) HAS NO OVERRIDE. A plan the engine refused can never
 * become an order: `requireApprovedForExecution` has no override parameter and throws unless the
 * verdict is a clean approval. The journal (logging a trade that already happened or is being
 * studied) may accept an override with a typed reason; an order may not.
 */

export class ExecutionRefusedError extends Error {
  readonly codes: string[];
  constructor(codes: string[]) {
    super(
      `The plan is not approved by the risk engine and cannot become an order (${codes.join(', ') || 'no verdict'}).`,
    );
    this.name = 'ExecutionRefusedError';
    this.codes = codes;
  }
}

export function requireApprovedForExecution(
  verdict: Verdict | null | undefined,
): asserts verdict is Verdict {
  if (!verdict || verdict.approved !== true || verdict.violations.length > 0) {
    throw new ExecutionRefusedError(verdict?.violations.map((v) => v.code) ?? []);
  }
}

export const OVERRIDE_WORD = 'OVERRIDE';
export const RESET_WORD = 'RESET';
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

interface Confirmation {
  confirm?: string | null;
  reason?: string | null;
}

function validate(input: Confirmation, word: string, what: string): { reason: string } {
  const issues = [];
  if ((input.confirm ?? '') !== word) {
    issues.push({
      field: 'confirm',
      message: `Type the exact word ${word} (capital letters) to ${what}.`,
    });
  }
  const reason = (input.reason ?? '').trim();
  if (reason.length < MIN_REASON_LENGTH) {
    issues.push({
      field: 'reason',
      message: `Give a reason of at least ${MIN_REASON_LENGTH} characters.`,
    });
  } else if (reason.length > MAX_REASON_LENGTH) {
    issues.push({
      field: 'reason',
      message: `The reason can be at most ${MAX_REASON_LENGTH} characters.`,
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { reason };
}

/** Typed confirmation + reason needed to LOG a trade that the risk engine refused. */
export const validateOverride = (input: Confirmation) =>
  validate(input, OVERRIDE_WORD, 'log a trade that breaks your risk rules');

/** Typed confirmation + reason needed to reset a halt. */
export const validateReset = (input: Confirmation) => validate(input, RESET_WORD, 'reset the halt');

/** A manual halt only needs a short reason. */
export function validateHaltReason(reason: string | null | undefined): string {
  const text = (reason ?? '').trim();
  if (text.length < 3 || text.length > MAX_REASON_LENGTH) {
    throw new ValidationError([
      { field: 'reason', message: `Give a reason between 3 and ${MAX_REASON_LENGTH} characters.` },
    ]);
  }
  return text;
}

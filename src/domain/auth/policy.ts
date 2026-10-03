import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';

/**
 * Password policy for the single owner.
 *
 * - at least 12 characters (and at most 128, so nobody can send a gigantic "password" to be hashed)
 * - judged by zxcvbn-ts, which estimates how many guesses a real attacker would need and knows
 *   common passwords, keyboard walks, dates, l33t tricks and the words in `userInputs`
 * - must not contain words tied to this app
 *
 * The estimator is a safety net, not magic: a long random password or passphrase from a password
 * manager is what really protects you (see docs/security.md).
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
/** zxcvbn score: 0 (trivial) .. 4 (very strong). 3 = "safely unguessable" for an online attacker. */
export const MIN_PASSWORD_SCORE = 3;

/** Words that must not appear in the password (case-insensitive). */
export const FORBIDDEN_WORDS = ['houcine', 'trades', 'trading'] as const;

// Built on first use (the dictionaries are large).
let estimator: ZxcvbnFactory | undefined;
function getEstimator(): ZxcvbnFactory {
  estimator ??= new ZxcvbnFactory({
    translations: english.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...english.dictionary },
    useLevenshteinDistance: true,
  });
  return estimator;
}

export interface PasswordCheck {
  ok: boolean;
  /** Plain-language reasons (empty when ok). Never contains the password. */
  problems: string[];
}

export function checkPassword(password: string, extraWords: readonly string[] = []): PasswordCheck {
  const problems: string[] = [];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  if (typeof password === 'string' && password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`The password must be at most ${MAX_PASSWORD_LENGTH} characters long.`);
  }
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false, problems };
  }

  const lower = password.toLowerCase();
  for (const word of [...FORBIDDEN_WORDS, ...extraWords.filter((w) => w.length >= 3)]) {
    if (lower.includes(word.toLowerCase())) {
      problems.push('The password must not contain your name or the name of this app.');
      break;
    }
  }

  if (password.length >= MIN_PASSWORD_LENGTH) {
    const result = getEstimator().check(password, [...FORBIDDEN_WORDS, ...extraWords]);
    if (result.score < MIN_PASSWORD_SCORE) {
      problems.push(
        'This password is too easy to guess (it is common, or follows a pattern such as a keyboard ' +
          'walk, a date or a known word). Use a long random password or a passphrase of several ' +
          'unrelated words.',
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

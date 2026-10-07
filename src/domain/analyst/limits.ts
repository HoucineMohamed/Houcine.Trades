/**
 * Per-request limits of the analyst. They live in CODE (not in settings) so nothing can raise
 * them from the web.
 */
export const REQUEST_LIMITS = {
  /** Largest answer the model may produce, thinking included. */
  maxOutputTokens: 4000,
  /** Give up on a request after this long (no retry follows). */
  timeoutMs: 60_000,
  /** The whole prompt (system + data) is never longer than this many characters. */
  maxInputChars: 24_000,
  /** One note / emotion / setup name is cut to this many characters. */
  maxFieldChars: 1_500,
  /** A tutor question is cut to this many characters. */
  maxQuestionChars: 1_000,
  /** At most this many trades go into a weekly review (the newest ones). */
  maxTrades: 40,
  /** A conservative guess for tokens from characters, used ONLY to project the worst-case cost. */
  charsPerTokenForProjection: 2,
} as const;

export const TRUNCATION_MARKER = '[TRUNCATED: the rest of this text was not sent]';

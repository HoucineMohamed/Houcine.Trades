import { Dec } from '../money/decimal';

/**
 * The price table the usage log uses to ESTIMATE what a call cost. It is an estimate only: the
 * spend limit you set in the Anthropic console is the real hard stop.
 *
 * HOW TO UPDATE (when Anthropic changes a price or a model is added):
 *  1. Open https://platform.claude.com/docs/en/about-claude/pricing and the models overview.
 *  2. Edit the numbers below (US dollars per million tokens, as text) and PRICES_LAST_VERIFIED.
 *  3. Run `npm test`: a test fails if ANALYST_MODEL is not in this table.
 *
 * LAST VERIFIED: 2026-10-07 (against the official pricing and models pages).
 */
export const PRICES_LAST_VERIFIED = '2026-10-07';

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: string;
  /** USD per million output tokens (thinking tokens are billed as output). */
  outputPerMTok: string;
  /** Whether the request may carry output_config.effort (a 400 on models without it). */
  supportsEffort: boolean;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { inputPerMTok: '2', outputPerMTok: '10', supportsEffort: true },
  'claude-opus-5-5': { inputPerMTok: '4', outputPerMTok: '20', supportsEffort: true },
  'claude-fable-5-1': { inputPerMTok: '10', outputPerMTok: '50', supportsEffort: true },
  'claude-haiku-4-5': { inputPerMTok: '1', outputPerMTok: '5', supportsEffort: false },
  'claude-haiku-4-5-20251001': { inputPerMTok: '1', outputPerMTok: '5', supportsEffort: false },
};

export const DEFAULT_ANALYST_MODEL = 'claude-sonnet-5-5';

export const isPricedModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(PRICE_TABLE, model);

/**
 * Estimated cost in US dollars (decimal text, 6 decimals, rounded UP so the estimate never
 * understates). Returns null for a model that is not in the table: the caller must then refuse.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): string | null {
  if (!isPricedModel(model)) return null;
  if (
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return null;
  }
  const price = PRICE_TABLE[model] as ModelPrice;
  const total = new Dec(inputTokens)
    .times(price.inputPerMTok)
    .plus(new Dec(outputTokens).times(price.outputPerMTok))
    .div(1_000_000);
  return total.toDecimalPlaces(6, Dec.ROUND_UP).toFixed(6);
}

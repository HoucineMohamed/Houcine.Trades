import 'server-only';
import { z } from 'zod';
import { DEFAULT_ANALYST_MODEL, isPricedModel } from '@/domain/analyst/pricing';

/**
 * Settings of the analyst, validated with zod and read lazily (like AUTH_SECRET). Builds, tests
 * and the db:* commands never need ANTHROPIC_API_KEY. A missing or placeholder key simply means
 * "the analyst is off": the rest of the app is unchanged. Nothing here ever echoes a value.
 */

const PLACEHOLDER = /replace|change.?me|placeholder|example|your[-_ ]|insert|todo|key.?here|xxxx/i;

const keySchema = z
  .string()
  .trim()
  .min(40, 'ANTHROPIC_API_KEY is too short to be a real key')
  .refine((v) => !PLACEHOLDER.test(v), 'ANTHROPIC_API_KEY still looks like the placeholder')
  .refine((v) => v.startsWith('sk-ant-'), 'ANTHROPIC_API_KEY does not start with "sk-ant-"')
  .refine((v) => /^[A-Za-z0-9_-]+$/.test(v), 'ANTHROPIC_API_KEY contains unexpected characters');

const modelSchema = z
  .string()
  .trim()
  .refine(
    isPricedModel,
    'ANALYST_MODEL is not in the price table (src/domain/analyst/pricing.ts), so costs could not be estimated',
  );

export type AnalystEnv =
  | { status: 'ready'; apiKey: string; model: string }
  | { status: 'no_key'; message: string }
  | { status: 'invalid'; message: string };

/** Never throws and never echoes a value: only WHICH setting is wrong and why. */
export function parseAnalystEnv(source: Record<string, string | undefined>): AnalystEnv {
  const rawKey = source.ANTHROPIC_API_KEY;
  if (rawKey === undefined || rawKey.trim() === '') {
    return {
      status: 'no_key',
      message: 'No API key is set. The analyst is off. See docs/analyst.md to set one up.',
    };
  }
  const key = keySchema.safeParse(rawKey);
  if (!key.success) {
    return {
      status: 'invalid',
      message: `${key.error.issues[0]?.message ?? 'ANTHROPIC_API_KEY is not valid'}. The analyst is off. Run "npm run ai:set-key" again.`,
    };
  }
  const rawModel = source.ANALYST_MODEL;
  const model = modelSchema.safeParse(
    rawModel === undefined || rawModel.trim() === '' ? DEFAULT_ANALYST_MODEL : rawModel,
  );
  if (!model.success) {
    return {
      status: 'invalid',
      message: `${model.error.issues[0]?.message ?? 'ANALYST_MODEL is not valid'}. The analyst is off.`,
    };
  }
  return { status: 'ready', apiKey: key.data, model: model.data };
}

/** Read from the environment each time (cheap), so a changed .env takes effect after a restart only. */
export function getAnalystEnv(): AnalystEnv {
  return parseAnalystEnv(process.env);
}

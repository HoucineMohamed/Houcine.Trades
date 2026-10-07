import 'server-only';
import { createAnthropicClient } from '@/integrations/anthropic/client';
import { getAnalystEnv } from '@/integrations/anthropic/env';
import type { AnalystRuntime } from './service';

/**
 * Builds the real runtime from the environment, lazily. The API key goes into the client and
 * nowhere else: it is not returned, stored or shown. A missing or invalid key (or model) gives an
 * "unavailable" runtime with a plain message, and the rest of the app is unchanged.
 */
export function getAnalystRuntime(): AnalystRuntime {
  const env = getAnalystEnv();
  if (env.status !== 'ready') return { status: 'unavailable', message: env.message };
  return { status: 'ready', client: createAnthropicClient(env.apiKey), model: env.model };
}

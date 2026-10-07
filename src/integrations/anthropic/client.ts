import 'server-only';
import { z } from 'zod';
import type { AnalystClient, AnalystRequest, AnalystResult } from './types';

/**
 * The real client: one HTTPS POST to the Messages API with `fetch`, no SDK, no dependency.
 *
 *  - The URL is a constant (never built from user input).
 *  - The body has NO `tools`, no files and no web access: text in, text out.
 *  - NO retries: one request, one answer, or a plain failure.
 *  - The key goes only in the `x-api-key` header and is never put in a message, a log or a result.
 *  - Provider error text is never passed on: only a fixed description and the request id.
 *
 * Checked against https://platform.claude.com/docs/en/api/messages and .../api/errors on 2026-10-07.
 */

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
});

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  stop_reason: z.string().nullable(),
  usage: usageSchema,
});

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,100}$/;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function buildRequestBody(req: AnalystRequest): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
  };
}

const failure = (
  reason: 'api_error' | 'timeout' | 'refused' | 'truncated',
  detail: string,
  billing: 'none' | 'unknown',
  inputTokens: number | null = null,
  outputTokens: number | null = null,
): AnalystResult => ({ ok: false, reason, detail, billing, inputTokens, outputTokens });

function httpDetail(status: number, requestId: string | null, errorType: string | null): string {
  const hint =
    status === 401
      ? 'the key was not accepted'
      : status === 402
        ? 'a billing problem was reported'
        : status === 400 || status === 429
          ? 'the request was refused (this can also mean a spend limit set in the Anthropic console was reached, or a rate limit)'
          : status === 529 || status >= 500
            ? 'the service is busy or down'
            : 'the request was refused';
  return `HTTP ${status}${errorType ? ` ${errorType}` : ''}: ${hint}${requestId ? ` (request id ${requestId})` : ''}`;
}

export function createAnthropicClient(apiKey: string, fetchImpl: FetchLike = fetch): AnalystClient {
  return {
    async complete(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(MESSAGES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(buildRequestBody(req)),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        clearTimeout(timer);
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return failure(
            'timeout',
            `no answer within ${Math.round(req.timeoutMs / 1000)} seconds`,
            'unknown',
          );
        }
        return failure('api_error', 'the request could not be sent (network problem)', 'unknown');
      }
      try {
        const requestIdRaw = response.headers.get('request-id');
        const requestId = requestIdRaw && SAFE_TOKEN.test(requestIdRaw) ? requestIdRaw : null;
        if (!response.ok) {
          let errorType: string | null = null;
          try {
            const body: unknown = await response.json();
            const t = (body as { error?: { type?: unknown } })?.error?.type;
            if (typeof t === 'string' && SAFE_TOKEN.test(t)) errorType = t;
          } catch {
            errorType = null;
          }
          return failure('api_error', httpDetail(response.status, requestId, errorType), 'none');
        }
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          return failure('api_error', 'the reply could not be read', 'unknown');
        }
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success)
          return failure('api_error', 'the reply had an unexpected shape', 'unknown');
        const u = parsed.data.usage;
        const inputTokens =
          u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        const outputTokens = u.output_tokens;
        const stop = parsed.data.stop_reason;
        if (stop === 'refusal')
          return failure(
            'refused',
            'the model declined to answer',
            'unknown',
            inputTokens,
            outputTokens,
          );
        if (stop === 'max_tokens') {
          return failure(
            'truncated',
            'the answer was cut off at the size limit',
            'unknown',
            inputTokens,
            outputTokens,
          );
        }
        if (stop !== 'end_turn' && stop !== 'stop_sequence') {
          return failure(
            'api_error',
            'the reply ended in an unexpected way',
            'unknown',
            inputTokens,
            outputTokens,
          );
        }
        const text = parsed.data.content
          .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
          .join('');
        return { ok: true, text, inputTokens, outputTokens };
      } catch {
        if (controller.signal.aborted)
          return failure(
            'timeout',
            `no answer within ${Math.round(req.timeoutMs / 1000)} seconds`,
            'unknown',
          );
        return failure('api_error', 'the reply could not be read', 'unknown');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
